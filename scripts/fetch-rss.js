#!/usr/bin/env node

/**
 * PAI AeroNews - RSS Feed Fetching Script
 *
 * Fetches aviation news from RSS feeds and generates static HTML.
 * Uses Anthropic Claude API to generate AI takeaways.
 *
 * Usage:
 *   node scripts/fetch-rss.js
 *   ANTHROPIC_API_KEY=xxx node scripts/fetch-rss.js
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { XMLParser } from 'fast-xml-parser';
import { canSpendClaude, recordClaudeCalls, claudeCallsRemaining } from './usage-limit.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Configuration
const CONFIG = {
  anthropicApiKey: process.env.ANTHROPIC_API_KEY,
  teamsWebhookUrl: process.env.TEAMS_WEBHOOK_URL,
  slackWebhookUrl: process.env.SLACK_WEBHOOK_URL,
  outputDir: path.join(__dirname, '..', 'dist'),
  templatePath: path.join(__dirname, '..', 'src', 'template.html'),
  sourcesPath: path.join(__dirname, '..', 'sources.json'),
  manualPath: path.join(__dirname, '..', 'manual.json'),
  paiContentPath: path.join(__dirname, '..', 'pai-content-library.json'),
  scrollDuration: 60, // seconds for full scroll cycle
};

// Category display names and colors
const VALID_CATEGORIES = new Set([
  'general-aviation', 'commercial', 'business-aviation', 'industry',
  'aerospace', 'military', 'safety', 'regulatory', 'corporate',
  'evtol', 'drones', 'electric', 'international', 'air-cargo',
]);

const CATEGORY_INFO = {
  'general-aviation': { label: 'General Aviation', color: '#10B981' },
  'commercial': { label: 'Commercial', color: '#3B82F6' },
  'business-aviation': { label: 'Business Aviation', color: '#8B5CF6' },
  'industry': { label: 'Industry', color: '#F59E0B' },
  'aerospace': { label: 'Aerospace', color: '#EC4899' },
  'evtol': { label: 'eVTOL', color: '#06B6D4' },
  'drones': { label: 'Drones', color: '#84CC16' },
  'electric': { label: 'Electric', color: '#22D3EE' },
  'regulatory': { label: 'Regulatory', color: '#EF4444' },
  'safety': { label: 'Safety', color: '#DC2626' },
  'military': { label: 'Military', color: '#6B7280' },
  'corporate': { label: 'Corporate', color: '#A855F7' },
  'international': { label: 'International', color: '#14B8A6' },
  'air-cargo': { label: 'Air Cargo', color: '#F97316' },
};

/**
 * Load RSS feed sources from sources.json
 */
function loadSources() {
  try {
    const sourcesData = fs.readFileSync(CONFIG.sourcesPath, 'utf-8');
    const sources = JSON.parse(sourcesData);
    return sources;
  } catch (error) {
    console.error('Failed to load sources.json:', error.message);
    process.exit(1);
  }
}

/**
 * Load manual articles from manual.json
 */
function loadManualArticles() {
  try {
    const manualData = fs.readFileSync(CONFIG.manualPath, 'utf-8');
    const manual = JSON.parse(manualData);
    return manual.articles || [];
  } catch (error) {
    console.warn('No manual.json found or invalid format, skipping manual articles');
    return [];
  }
}

/**
 * Blog series slug → readable name mapping
 */
const BLOG_NAMES = {
  'sms-quick-takes': 'SMS Quick Takes',
  'stet-happens': 'Stet Happens',
  'meeting-your-needs': 'Meeting Your Needs',
};

/**
 * Load PAI content library from pai-content-library.json
 * Returns null if file is missing or malformed (graceful fallback)
 */
function loadPaiContentLibrary() {
  try {
    const data = fs.readFileSync(CONFIG.paiContentPath, 'utf-8');
    const library = JSON.parse(data);
    if (!library || typeof library !== 'object') return null;
    return library;
  } catch (error) {
    console.warn('No pai-content-library.json found or invalid format, skipping PAI content mixing');
    return null;
  }
}

/**
 * Select PAI blog articles for this cycle using priority weighting
 */
function selectPaiBlogArticles(blogArticles, max) {
  const active = blogArticles.filter(a => a.active);
  if (active.length === 0 || max <= 0) return [];

  // Build weighted pool: high priority items appear 2x
  const weighted = [];
  for (const article of active) {
    weighted.push(article);
    if (article.priority === 'high') {
      weighted.push(article);
    }
  }

  // Shuffle and pick unique items up to max
  const shuffled = weighted.sort(() => Math.random() - 0.5);
  const selected = [];
  const seen = new Set();
  for (const article of shuffled) {
    if (seen.has(article.id)) continue;
    seen.add(article.id);
    selected.push(article);
    if (selected.length >= max) break;
  }

  return selected;
}

/**
 * Select YouTube videos for this cycle, preferring keyword overlap with current news
 */
function selectPaiVideos(videos, max, newsKeywords) {
  const active = videos.filter(v => v.active);
  if (active.length === 0 || max <= 0) return [];

  // Score by keyword overlap with current news
  const scored = active.map(video => {
    const overlap = (video.matchKeywords || []).filter(k =>
      newsKeywords.has(k.toLowerCase())
    ).length;
    return { video, overlap };
  });

  // Sort by overlap descending, then shuffle ties
  scored.sort((a, b) => b.overlap - a.overlap || (Math.random() - 0.5));

  return scored.slice(0, max).map(s => s.video);
}

/**
 * Fetch YouTube playlist feeds and convert entries to video objects.
 * Runs all feeds in parallel; failures are logged and skipped.
 */
async function fetchYoutubeFeeds(youtubeFeeds, existingVideoUrls) {
  const activeFeeds = (youtubeFeeds || []).filter(f => f.active);
  if (activeFeeds.length === 0) return [];

  console.log(`\nFetching ${activeFeeds.length} YouTube playlist feed(s)...`);

  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
  });

  const results = await Promise.allSettled(activeFeeds.map(async (feed) => {
    const url = `https://www.youtube.com/feeds/videos.xml?playlist_id=${feed.playlistId}`;
    console.log(`  Fetching: ${feed.name}...`);

    const response = await fetch(url, {
      headers: {
        'User-Agent': 'PAI-AeroNews/1.0 (Aviation News Aggregator)',
        'Accept': 'application/xml, text/xml, */*',
      },
      signal: AbortSignal.timeout(15000),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const xml = await response.text();
    const parsed = parser.parse(xml);

    // YouTube uses Atom format — entries are in parsed.feed.entry
    let entries = parsed.feed?.entry || [];
    if (!Array.isArray(entries)) entries = [entries];

    // Limit to maxVideosPerFetch (newest first — YouTube returns them in order)
    entries = entries.slice(0, feed.maxVideosPerFetch || 3);

    const videos = [];
    for (const entry of entries) {
      // Extract link — can be array or single object
      let videoUrl = '';
      if (Array.isArray(entry.link)) {
        const alt = entry.link.find(l => l['@_rel'] === 'alternate');
        videoUrl = alt?.['@_href'] || entry.link[0]?.['@_href'] || '';
      } else if (entry.link) {
        videoUrl = entry.link['@_href'] || '';
      }

      // Skip if this URL is already in the manual videos array
      if (existingVideoUrls.has(videoUrl)) continue;

      // Extract video ID — prefer yt:videoId, fall back to URL parsing
      let videoId = entry['yt:videoId'] || '';
      if (!videoId && videoUrl) {
        const match = videoUrl.match(/[?&]v=([^&]+)/);
        if (match) videoId = match[1];
      }
      if (!videoId) continue; // skip entries we can't identify

      // Extract description from media:group
      const description = entry['media:group']?.['media:description'] || '';
      const blurb = typeof description === 'string'
        ? (description.length > 200
          ? description.substring(0, 200).replace(/\s+\S*$/, '') + '...'
          : description.trim())
        : '';

      const title = typeof entry.title === 'object'
        ? (entry.title['#text'] || '')
        : (entry.title || '');

      videos.push({
        id: `yt-auto-${videoId}`,
        headline: title,
        blurb,
        youtubeUrl: videoUrl,
        channel: feed.channelName,
        duration: '',
        category: feed.category,
        matchKeywords: feed.matchKeywords || [],
        active: true,
        autoFetched: true,
      });
    }

    console.log(`    ✓ Found ${videos.length} video(s) from ${feed.name}`);
    return videos;
  }));

  // Collect successful results, log failures
  const allVideos = [];
  for (let i = 0; i < results.length; i++) {
    if (results[i].status === 'fulfilled') {
      allVideos.push(...results[i].value);
    } else {
      console.warn(`    ✗ Failed to fetch ${activeFeeds[i].name}: ${results[i].reason?.message || results[i].reason}`);
    }
  }

  // Deduplicate by YouTube URL within auto-fetched results
  const seen = new Set();
  const dedupedVideos = allVideos.filter(v => {
    if (seen.has(v.youtubeUrl)) return false;
    seen.add(v.youtubeUrl);
    return true;
  });

  console.log(`  YouTube auto-fetch total: ${dedupedVideos.length} video(s)\n`);
  return dedupedVideos;
}

/**
 * Convert a PAI blog article to the feed article format
 */
function convertPaiBlogToArticle(blog) {
  const blogName = BLOG_NAMES[blog.blog] || blog.blog;
  return {
    id: blog.id,
    type: 'pai-blog',
    headline: blog.headline,
    blurb: blog.blurb,
    takeaway: '',
    source: {
      name: `PAI Consulting — ${blogName}`,
      url: `https://www.paiconsulting.com${blog.url}`,
    },
    category: blog.category,
    keywords: blog.keywords || [],
    publishedAt: new Date().toISOString(),
    paiContent: true,
  };
}

/**
 * Convert a YouTube video to the feed article format
 */
function convertVideoToArticle(video) {
  return {
    id: video.id,
    type: 'video',
    headline: video.headline,
    blurb: video.blurb,
    takeaway: '',
    source: {
      name: `${video.channel} (YouTube)`,
      url: video.youtubeUrl,
    },
    category: video.category,
    keywords: video.matchKeywords || [],
    publishedAt: new Date().toISOString(),
    videoContent: true,
    duration: video.duration || '',
  };
}

/**
 * Select curated articles for this cycle (simple random pick from active items)
 */
function selectCuratedArticles(curatedArticles, max) {
  const active = curatedArticles.filter(a => a.active);
  if (active.length === 0 || max <= 0) return [];

  const shuffled = [...active].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, max);
}

/**
 * Convert a curated article to the feed article format
 */
function convertCuratedToArticle(curated) {
  return {
    id: curated.id,
    type: 'curated',
    headline: curated.headline,
    blurb: curated.blurb,
    takeaway: '',
    source: {
      name: curated.sourceName,
      url: curated.sourceUrl,
    },
    category: curated.category,
    keywords: curated.keywords || [],
    publishedAt: new Date().toISOString(),
  };
}

/**
 * Merge PAI items into the articles array at natural-looking positions
 * - Never place as the very first article
 * - First PAI item around position 3-5
 * - Additional items spaced at least 4-5 positions apart
 */
function mergePaiItems(articles, paiItems) {
  if (paiItems.length === 0) return articles;

  const result = [...articles];
  const startPos = 3 + Math.floor(Math.random() * 3); // position 3-5
  const spacing = 4 + Math.floor(Math.random() * 2);   // 4-5 apart

  for (let i = 0; i < paiItems.length; i++) {
    const insertAt = Math.min(startPos + i * spacing, result.length);
    result.splice(insertAt, 0, paiItems[i]);
  }

  return result;
}

/**
 * Fetch and parse a single RSS feed
 */
async function fetchFeed(feed) {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
  });

  try {
    console.log(`  Fetching: ${feed.name}...`);
    const response = await fetch(feed.url, {
      headers: {
        'User-Agent': 'PAI-AeroNews/1.0 (Aviation News Aggregator)',
        'Accept': 'application/rss+xml, application/xml, text/xml, */*',
      },
      signal: AbortSignal.timeout(15000), // 15 second timeout
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const xml = await response.text();
    const parsed = parser.parse(xml);

    // Handle different RSS formats
    let items = [];
    if (parsed.rss?.channel?.item) {
      items = Array.isArray(parsed.rss.channel.item)
        ? parsed.rss.channel.item
        : [parsed.rss.channel.item];
    } else if (parsed.feed?.entry) {
      // Atom format
      items = Array.isArray(parsed.feed.entry)
        ? parsed.feed.entry
        : [parsed.feed.entry];
    } else if (parsed.rdf?.item) {
      // RDF format
      items = Array.isArray(parsed.rdf.item)
        ? parsed.rdf.item
        : [parsed.rdf.item];
    }

    // Normalize items to common format
    const articles = items.map(item => normalizeArticle(item, feed));
    console.log(`    ✓ Found ${articles.length} articles`);
    return articles;

  } catch (error) {
    console.warn(`    ✗ Failed to fetch ${feed.name}: ${error.message}`);
    return [];
  }
}

/**
 * Normalize article from different RSS formats
 */
function normalizeArticle(item, feed) {
  // Handle title
  let title = item.title || item['dc:title'] || 'Untitled';
  if (typeof title === 'object') title = title['#text'] || 'Untitled';

  // Handle description
  let description = item.description || item.summary || item.content || item['content:encoded'] || '';
  if (typeof description === 'object') description = description['#text'] || '';

  // Handle link (Atom uses different structure)
  let link = item.link || '';
  if (typeof link === 'object') {
    link = link['@_href'] || link['#text'] || '';
  }
  if (Array.isArray(link)) {
    const htmlLink = link.find(l => l['@_type'] === 'text/html' || !l['@_type']);
    link = htmlLink ? (htmlLink['@_href'] || htmlLink) : link[0];
    if (typeof link === 'object') link = link['@_href'] || '';
  }

  // Handle date
  let pubDate = item.pubDate || item.published || item.updated || item['dc:date'] || new Date().toISOString();

  return {
    id: generateId(title, link),
    headline: cleanHeadline(title),
    blurb: cleanDescription(description),
    source: {
      name: feed.name,
      url: link,
    },
    category: feed.category,
    publishedAt: new Date(pubDate).toISOString(),
    takeaway: null, // Will be filled by AI
    keywords: extractKeywords(title + ' ' + description),
  };
}

/**
 * Generate a unique ID for an article
 */
function generateId(title, url) {
  const str = `${title}-${url}`;
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return Math.abs(hash).toString(36);
}

/**
 * Decode HTML entities (both named and numeric)
 */
function decodeHtmlEntities(text) {
  if (!text) return '';
  return text
    // Decode numeric entities like &#8216; &#8217; &#124;
    .replace(/&#(\d+);/g, (match, dec) => String.fromCharCode(dec))
    // Decode hex entities like &#x2019;
    .replace(/&#x([0-9a-fA-F]+);/g, (match, hex) => String.fromCharCode(parseInt(hex, 16)))
    // Decode common named entities
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&mdash;/g, '\u2014')
    .replace(/&ndash;/g, '\u2013')
    .replace(/&hellip;/g, '...')
    .replace(/&lsquo;/g, '\u2018')
    .replace(/&rsquo;/g, '\u2019')
    .replace(/&ldquo;/g, '\u201C')
    .replace(/&rdquo;/g, '\u201D');
}

/**
 * Clean headline text
 */
function cleanHeadline(title) {
  if (!title) return 'Aviation News';

  let cleaned = title;

  // Remove HTML tags first
  cleaned = cleaned.replace(/<[^>]*>/g, '');

  // Decode HTML entities
  cleaned = decodeHtmlEntities(cleaned);

  // Remove source suffix like " - CNN" or " | Reuters"
  // Only if the suffix looks like a source name (short, at end, after space-dash-space)
  // Be careful not to remove things like "F-35" or "737-800"
  cleaned = cleaned.replace(/\s+[-–—|]\s+[A-Z][A-Za-z\s]{2,20}$/, '');

  // Normalize whitespace and trim
  cleaned = cleaned.replace(/\s+/g, ' ').trim();

  return cleaned;
}

/**
 * Clean description text
 */
function cleanDescription(description) {
  if (!description) return '';

  let cleaned = description;

  // Remove HTML tags
  cleaned = cleaned.replace(/<[^>]*>/g, '');

  // Decode HTML entities
  cleaned = decodeHtmlEntities(cleaned);

  // Normalize whitespace and trim
  cleaned = cleaned.replace(/\s+/g, ' ').trim();

  // Limit length
  if (cleaned.length > 300) {
    cleaned = cleaned.substring(0, 300).replace(/\s+\S*$/, '') + '...';
  }

  return cleaned;
}

/**
 * Extract keywords from text for future filtering
 */
function extractKeywords(text) {
  const keywords = [];
  const lowerText = text.toLowerCase();

  const keywordPatterns = [
    'boeing', 'airbus', 'cessna', 'piper', 'cirrus', 'gulfstream', 'embraer',
    'faa', 'easa', 'ntsb', 'icao',
    'evtol', 'uam', 'drone', 'uas', 'aam',
    'electric', 'hybrid', 'sustainable', 'saf',
    'safety', 'crash', 'incident', 'accident',
    'airline', 'airport', 'pilot', 'atc',
    'nasa', 'spacex', 'space'
  ];

  for (const keyword of keywordPatterns) {
    if (lowerText.includes(keyword)) {
      keywords.push(keyword);
    }
  }

  return keywords;
}

/**
 * Daily Claude API call cap for the public pipeline.
 */
const CLAUDE_PUBLIC_CAP = parseInt(process.env.CLAUDE_DAILY_CALL_CAP_PUBLIC || '900', 10);


/**
 * Generate AI takeaway using Anthropic Claude API.
 * Enforces a hard daily call cap — falls back gracefully when exceeded.
 */
async function generateTakeaway(article) {
  if (!CONFIG.anthropicApiKey) {
    return createFallbackTakeaway(article);
  }

  // Hard daily cap check
  if (!canSpendClaude(1, CLAUDE_PUBLIC_CAP)) {
    if (!generateTakeaway._capLogged) {
      const remaining = claudeCallsRemaining(CLAUDE_PUBLIC_CAP);
      console.warn(`⚠ CLAUDE DAILY CAP REACHED (public pipeline cap: ${CLAUDE_PUBLIC_CAP}, remaining: ${remaining}). Using fallback takeaways for remaining articles.`);
      generateTakeaway._capLogged = true;
    }
    return createFallbackTakeaway(article);
  }

  const systemPrompt = 'You are a concise aviation industry analyst. Generate a single sentence of insight for aviation professionals. Output ONLY a JSON object — no preamble, no commentary, no questions, no refusals, no meta-analysis. If the article is about aerospace or space exploration, write about its relevance to aerospace. Never output anything except the JSON object.';

  const userPrompt = `Write a one-sentence insight for aviation professionals about this article. The takeaway must be a single crisp sentence, ideally under 160 characters and never more than 180 characters. Do not restate or paraphrase the headline. The takeaway must provide new information — context, significance, or implication — that is not already stated in the headline or blurb. Also determine the most accurate category for this article from this list: general-aviation, commercial, business-aviation, industry, aerospace, military, safety, regulatory, corporate, evtol, drones, electric, international, air-cargo.

Return ONLY a JSON object in this exact format, nothing else:
{"takeaway": "your single insight sentence", "category": "best-matching-category"}

If unsure about the category, use: ${article.category}

Article headline: ${article.headline}
Article description: ${article.blurb || 'No description available'}`;

  let attempted = false;
  try {
    const fetchPromise = fetch(
      'https://api.anthropic.com/v1/messages',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': CONFIG.anthropicApiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 150,
          system: systemPrompt,
          messages: [{
            role: 'user',
            content: userPrompt,
          }],
        }),
      }
    );
    attempted = true;
    const response = await fetchPromise;

    const data = await response.json();

    if (data.content?.[0]?.text) {
      const rawText = data.content[0].text.trim();
      try {
        // Try to extract JSON from the response (handle markdown code fences)
        const jsonMatch = rawText.match(/\{[\s\S]*\}/);
        if (!jsonMatch) throw new Error('No JSON object found in response');
        const parsed = JSON.parse(jsonMatch[0]);

        const takeaway = typeof parsed.takeaway === 'string' && parsed.takeaway.length > 0
          ? parsed.takeaway
          : null;
        const correctedCategory = typeof parsed.category === 'string'
          && VALID_CATEGORIES.has(parsed.category)
          ? parsed.category
          : null;

        if (takeaway) {
          if (correctedCategory) article.category = correctedCategory;
          return takeaway;
        }
      } catch (parseError) {
        console.warn(`  ⚠ JSON parse failed for "${article.headline.substring(0, 40)}…", using fallback`);
      }
    }
  } catch (error) {
    console.warn(`AI takeaway failed for "${article.headline}":`, error.message);
  } finally {
    if (attempted) recordClaudeCalls(1);
  }

  console.warn('  ⚠ Using fallback takeaway for: ' + article.headline.substring(0, 50));
  return createFallbackTakeaway(article);
}

/**
 * Create a simple takeaway when AI is unavailable
 */
function createFallbackTakeaway(article) {
  const text = `${article.headline} ${article.blurb || ''}`.toLowerCase();
  const category = article.category;

  // Category-specific fallbacks
  if (category === 'safety' || text.includes('safety') || text.includes('crash') || text.includes('incident')) {
    return 'Safety implications warrant industry attention.';
  }
  if (category === 'regulatory' || text.includes('faa') || text.includes('easa') || text.includes('regulation')) {
    return 'Regulatory changes may affect industry operations.';
  }
  if (category === 'evtol' || text.includes('evtol') || text.includes('air taxi') || text.includes('urban air')) {
    return 'Urban air mobility advances toward commercial reality.';
  }
  if (category === 'drones' || text.includes('drone') || text.includes('uas') || text.includes('unmanned')) {
    return 'Drone technology continues to reshape aviation operations.';
  }
  if (category === 'electric' || text.includes('electric') || text.includes('hybrid') || text.includes('sustainable')) {
    return 'Sustainable aviation technology gains momentum.';
  }
  if (text.includes('boeing')) {
    return 'Boeing developments impact global aviation supply chain.';
  }
  if (text.includes('airbus')) {
    return 'Airbus activity reflects European aerospace trends.';
  }
  if (category === 'aerospace' || text.includes('nasa') || text.includes('space')) {
    return 'Aerospace developments expand industry horizons.';
  }
  if (category === 'military') {
    return 'Military aviation advances influence broader industry.';
  }
  if (category === 'commercial' || text.includes('airline') || text.includes('airport')) {
    return 'Commercial aviation dynamics shape travel industry.';
  }
  if (category === 'business-aviation') {
    return 'Business aviation sector shows evolving market trends.';
  }

  return 'Industry developments to monitor closely.';
}

/**
 * Format date for display
 */
function formatDate(isoDate) {
  const date = new Date(isoDate);
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

/**
 * Format date/time for display
 */
function formatDateTime(isoDate) {
  const date = new Date(isoDate);
  return date.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

/**
 * Escape HTML special characters
 */
function escapeHtml(text) {
  if (!text) return '';
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Generate HTML for a single news card
 */
function generateNewsCard(article, index) {
  const date = formatDate(article.publishedAt);
  const categoryInfo = CATEGORY_INFO[article.category] || { label: 'News', color: '#6B7280' };
  const type = article.type || 'news';

  // Escape content for HTML attributes (for modal data)
  const escapedHeadline = escapeHtml(article.headline);
  const escapedBlurb = escapeHtml(article.blurb);
  const escapedTakeaway = escapeHtml(article.takeaway);
  const escapedSourceName = escapeHtml(article.source.name);
  const escapedSourceUrl = escapeHtml(article.source.url);
  const escapedDuration = escapeHtml(article.duration || '');

  // PAI blog cards link same-tab; video and news open new tab
  const linkTarget = type === 'pai-blog' ? '' : ' target="_blank" rel="noopener noreferrer"';

  // PAI badge for pai-blog cards
  const paiBadge = type === 'pai-blog'
    ? '<span class="pai-badge">PAI</span>'
    : '';

  // Video overlay for video cards
  const videoOverlay = type === 'video'
    ? `<div class="video-overlay"><span class="video-play-icon">&#9654;</span>${escapedDuration ? `<span class="video-duration">${escapedDuration}</span>` : ''}</div>`
    : '';

  // Extra CSS class for card type
  const typeClass = type !== 'news' ? ` card-type-${type}` : '';

  return `
        <div class="news-card${typeClass}"
             data-index="${index}"
             data-type="${type}"
             data-headline="${escapedHeadline}"
             data-blurb="${escapedBlurb}"
             data-takeaway="${escapedTakeaway}"
             data-source-name="${escapedSourceName}"
             data-source-url="${escapedSourceUrl}"
             data-category="${article.category}"
             data-date="${formatDateTime(article.publishedAt)}"
             data-duration="${escapedDuration}"
             onclick="openModal(this)">
          ${paiBadge}
          ${videoOverlay}
          <div class="card-header">
            <span class="category-badge" style="background-color: ${categoryInfo.color}">${categoryInfo.label}</span>
            <span class="date">${date}</span>
          </div>
          <h2 class="headline">${escapedHeadline}</h2>
          <p class="blurb">${escapedBlurb}</p>
          <p class="takeaway">${escapedTakeaway}</p>
          <p class="source-link">
            See <a href="${escapedSourceUrl}"${linkTarget} onclick="event.stopPropagation()">${escapedSourceName}</a> &rarr;
          </p>
        </div>`;
}

/**
 * Generate the full HTML output
 */
async function generateHTML(articles, sources) {
  console.log('\nReading template...');
  const template = fs.readFileSync(CONFIG.templatePath, 'utf-8');

  console.log('Generating takeaways...');
  const processedArticles = [];

  for (const article of articles) {
    const takeaway = await generateTakeaway(article);
    article.takeaway = takeaway;
    processedArticles.push(article);
    console.log(`  ✓ ${article.headline.substring(0, 50)}...`);
  }

  // Generate news cards
  const newsCards = processedArticles.map((article, index) =>
    generateNewsCard(article, index)
  );

  // Duplicate cards for seamless looping animation
  const duplicatedCards = [...newsCards, ...newsCards].join('\n');

  // Calculate scroll duration based on number of cards
  const scrollDuration = Math.max(60, articles.length * 3);

  // Generate timestamp
  const now = new Date();
  const timestamp = now.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  });

  // Generate source count summary
  const sourcesCount = sources.feeds.filter(f => f.enabled).length;
  const sourceSummary = `${articles.length} articles from ${sourcesCount} sources`;

  // Replace template placeholders (use regex with /g flag to replace ALL occurrences)
  const html = template
    .replace('{{NEWS_CARDS}}', duplicatedCards)
    .replace(/\{\{SCROLL_DURATION\}\}/g, String(scrollDuration))
    .replace('{{LAST_UPDATED}}', timestamp)
    .replace('{{SOURCE_SUMMARY}}', sourceSummary)
    .replace('{{ARTICLE_COUNT}}', String(articles.length));

  return { html, processedArticles };
}

/**
 * Write output files
 */
function writeOutput(html, articles) {
  // Ensure output directory exists
  if (!fs.existsSync(CONFIG.outputDir)) {
    fs.mkdirSync(CONFIG.outputDir, { recursive: true });
  }

  // Write HTML file
  const htmlPath = path.join(CONFIG.outputDir, 'index.html');
  fs.writeFileSync(htmlPath, html, 'utf-8');
  console.log(`\nHTML written to: ${htmlPath}`);

  // Write JSON data file (for future use / Phase 2)
  const jsonData = {
    lastUpdated: new Date().toISOString(),
    articles: articles.map(a => {
      const article = {
        id: a.id,
        type: a.type || 'news',
        headline: a.headline,
        blurb: a.blurb,
        takeaway: a.takeaway,
        source: a.source,
        category: a.category,
        keywords: a.keywords,
        publishedAt: a.publishedAt,
      };
      if (a.paiContent) article.paiContent = true;
      if (a.videoContent) {
        article.videoContent = true;
        if (a.duration) article.duration = a.duration;
      }
      return article;
    }),
  };

  const jsonPath = path.join(CONFIG.outputDir, 'news-data.json');
  fs.writeFileSync(jsonPath, JSON.stringify(jsonData, null, 2), 'utf-8');
  console.log(`JSON written to: ${jsonPath}`);
}

/**
 * Check if it's time to send the daily digest
 */
function isDailyDigestTime(webhookConfig) {
  const now = new Date();
  const digestHour = webhookConfig.dailyDigestHourUTC ?? 11;
  return now.getUTCHours() === digestHour;
}

/**
 * Build a Teams Adaptive Card payload for a daily digest
 */
function buildTeamsDigest(articles, maxArticles) {
  const topArticles = articles.slice(0, maxArticles);
  const today = new Date().toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });

  const articleRows = topArticles.map(article => {
    const categoryInfo = CATEGORY_INFO[article.category] || { label: 'News' };
    return {
      type: 'Container',
      separator: true,
      spacing: 'medium',
      items: [
        {
          type: 'TextBlock',
          text: `**[${article.headline}](${article.source.url})**`,
          wrap: true,
          size: 'default',
        },
        {
          type: 'ColumnSet',
          columns: [
            {
              type: 'Column',
              width: 'auto',
              items: [{
                type: 'TextBlock',
                text: categoryInfo.label,
                size: 'small',
                color: 'accent',
                weight: 'bolder',
              }],
            },
            {
              type: 'Column',
              width: 'auto',
              items: [{
                type: 'TextBlock',
                text: `— ${article.source.name}`,
                size: 'small',
                isSubtle: true,
              }],
            },
          ],
        },
        ...(article.takeaway ? [{
          type: 'TextBlock',
          text: `_${article.takeaway}_`,
          wrap: true,
          size: 'small',
          isSubtle: true,
        }] : []),
      ],
    };
  });

  return {
    type: 'message',
    attachments: [{
      contentType: 'application/vnd.microsoft.card.adaptive',
      content: {
        $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
        type: 'AdaptiveCard',
        version: '1.4',
        body: [
          {
            type: 'TextBlock',
            text: '✈️ PAI AeroNews Daily Digest',
            size: 'large',
            weight: 'bolder',
            color: 'accent',
          },
          {
            type: 'TextBlock',
            text: today,
            size: 'small',
            isSubtle: true,
            spacing: 'none',
          },
          {
            type: 'TextBlock',
            text: `Top ${topArticles.length} headlines from ${articles.length} total articles`,
            size: 'small',
            isSubtle: true,
          },
          ...articleRows,
        ],
      },
    }],
  };
}

/**
 * Build a Slack Block Kit payload for a daily digest
 */
function buildSlackDigest(articles, maxArticles) {
  const topArticles = articles.slice(0, maxArticles);
  const today = new Date().toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });

  const articleBlocks = topArticles.flatMap(article => {
    const categoryInfo = CATEGORY_INFO[article.category] || { label: 'News' };
    const takeawayText = article.takeaway ? `\n_${article.takeaway}_` : '';
    return [
      { type: 'divider' },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*<${article.source.url}|${article.headline}>*\n`
            + `${categoryInfo.label} — ${article.source.name}`
            + takeawayText,
        },
      },
    ];
  });

  return {
    blocks: [
      {
        type: 'header',
        text: {
          type: 'plain_text',
          text: '✈️ PAI AeroNews Daily Digest',
        },
      },
      {
        type: 'context',
        elements: [{
          type: 'mrkdwn',
          text: `${today} · Top ${topArticles.length} of ${articles.length} articles`,
        }],
      },
      ...articleBlocks,
      { type: 'divider' },
      {
        type: 'context',
        elements: [{
          type: 'mrkdwn',
          text: 'Powered by <https://www.paiconsulting.com|PAI Consulting> AeroNews',
        }],
      },
    ],
  };
}

/**
 * Send webhook notifications
 */
async function sendWebhookNotifications(articles, webhookConfig) {
  if (!webhookConfig?.enabled) return;

  const mode = webhookConfig.mode || 'daily';
  const maxArticles = webhookConfig.maxArticlesInDigest || 10;

  // Daily mode: only send at the configured hour
  if (mode === 'daily' && !isDailyDigestTime(webhookConfig)) {
    console.log('Webhooks: Not digest hour, skipping.');
    return;
  }

  console.log(`\nSending ${mode} webhook notifications...`);

  // Teams
  if (webhookConfig.teams?.enabled && CONFIG.teamsWebhookUrl) {
    try {
      const payload = buildTeamsDigest(articles, maxArticles);
      const response = await fetch(CONFIG.teamsWebhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(15000),
      });
      if (response.ok) {
        console.log('  ✓ Teams notification sent');
      } else {
        console.warn(`  ✗ Teams webhook failed: HTTP ${response.status}`);
      }
    } catch (error) {
      console.warn(`  ✗ Teams webhook error: ${error.message}`);
    }
  }

  // Slack
  if (webhookConfig.slack?.enabled && CONFIG.slackWebhookUrl) {
    try {
      const payload = buildSlackDigest(articles, maxArticles);
      const response = await fetch(CONFIG.slackWebhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(15000),
      });
      if (response.ok) {
        console.log('  ✓ Slack notification sent');
      } else {
        console.warn(`  ✗ Slack webhook failed: HTTP ${response.status}`);
      }
    } catch (error) {
      console.warn(`  ✗ Slack webhook error: ${error.message}`);
    }
  }
}

/**
 * Main execution
 */
async function main() {
  console.log('='.repeat(50));
  console.log('PAI AeroNews - RSS Feed Update');
  console.log('='.repeat(50));
  console.log('');

  try {
    // Load sources configuration
    const sources = loadSources();
    const enabledFeeds = sources.feeds.filter(f => f.enabled);
    console.log(`Found ${enabledFeeds.length} enabled RSS feeds\n`);

    // Load manual articles
    const manualArticles = loadManualArticles();
    if (manualArticles.length > 0) {
      console.log(`Found ${manualArticles.length} manual articles\n`);
    }

    // Fetch all feeds in parallel
    console.log('Fetching RSS feeds...');
    const feedPromises = enabledFeeds.map(feed => fetchFeed(feed));
    const feedResults = await Promise.all(feedPromises);

    // Flatten and combine all articles
    let allArticles = feedResults.flat();
    console.log(`\nTotal articles fetched: ${allArticles.length}`);

    // Add manual articles (with high priority)
    const formattedManualArticles = manualArticles.map(article => ({
      id: generateId(article.headline, article.url),
      headline: article.headline,
      blurb: article.blurb || '',
      source: {
        name: article.source || 'Performance Aircraft',
        url: article.url,
      },
      category: article.category || 'industry',
      publishedAt: article.date ? new Date(article.date).toISOString() : new Date().toISOString(),
      takeaway: article.takeaway || null,
      keywords: extractKeywords(article.headline + ' ' + (article.blurb || '')),
      priority: article.priority || 'normal',
    }));

    // Combine: manual first (by priority), then RSS sorted by date
    const highPriorityManual = formattedManualArticles.filter(a => a.priority === 'high');
    const normalManual = formattedManualArticles.filter(a => a.priority !== 'high');

    // Sort RSS articles by date (newest first)
    allArticles.sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));

    // Deduplicate by URL
    const seenUrls = new Set();
    const deduped = [];
    for (const article of allArticles) {
      if (!seenUrls.has(article.source.url)) {
        seenUrls.add(article.source.url);
        deduped.push(article);
      }
    }

    // Combine in order: high priority manual → RSS → normal manual
    const combinedArticles = [
      ...highPriorityManual,
      ...deduped,
      ...normalManual.filter(a => !seenUrls.has(a.source.url)),
    ];

    // Add type: "news" to all existing articles
    for (const article of combinedArticles) {
      if (!article.type) {
        article.type = 'news';
      }
    }

    // Mix in PAI content library items
    const paiLibrary = loadPaiContentLibrary();
    let paiItemsToMerge = [];

    if (paiLibrary) {
      const maxPaiBlog = paiLibrary.settings?.maxPaiItemsPerCycle ?? 2;
      const maxVideos = paiLibrary.settings?.maxVideosPerCycle ?? 1;

      // Collect all news keywords for video matching
      const newsKeywords = new Set();
      for (const article of combinedArticles) {
        for (const kw of (article.keywords || [])) {
          newsKeywords.add(kw.toLowerCase());
        }
      }

      // Select and convert blog articles
      const selectedBlogs = selectPaiBlogArticles(paiLibrary.blogArticles || [], maxPaiBlog);
      const blogArticles = selectedBlogs.map(convertPaiBlogToArticle);

      // Fetch auto YouTube feeds and combine with manual videos
      const manualVideos = paiLibrary.videos || [];
      const existingVideoUrls = new Set(manualVideos.map(v => v.youtubeUrl));
      const autoVideos = await fetchYoutubeFeeds(paiLibrary.youtubeFeeds || [], existingVideoUrls);
      const allVideos = [...manualVideos, ...autoVideos];

      // Select and convert videos
      const selectedVideos = selectPaiVideos(allVideos, maxVideos, newsKeywords);
      const videoArticles = selectedVideos.map(convertVideoToArticle);

      // Select and convert curated articles
      const maxCurated = paiLibrary.settings?.maxCuratedPerCycle ?? 1;
      const selectedCurated = selectCuratedArticles(paiLibrary.curatedArticles || [], maxCurated);
      const curatedArticles = selectedCurated.map(convertCuratedToArticle);

      paiItemsToMerge = [...blogArticles, ...videoArticles, ...curatedArticles];

      if (paiItemsToMerge.length > 0) {
        console.log(`PAI content: ${blogArticles.length} blog article(s), ${videoArticles.length} video(s), ${curatedArticles.length} curated article(s) selected for mixing`);
      }
    }

    // Merge PAI items at natural positions
    const mergedArticles = mergePaiItems(combinedArticles, paiItemsToMerge);

    // Limit to configured max
    const maxArticles = sources.settings?.maxArticlesInTicker || 36;
    const finalArticles = mergedArticles.slice(0, maxArticles);

    console.log(`After deduplication and limiting: ${finalArticles.length} articles\n`);

    if (finalArticles.length === 0) {
      console.warn('No articles found. Using fallback content.');
      process.exit(0);
    }

    // Generate HTML and JSON
    const { html, processedArticles } = await generateHTML(finalArticles, sources);

    // Write output files
    writeOutput(html, processedArticles);

    // Send webhook notifications (daily digest or every update)
    await sendWebhookNotifications(processedArticles, sources.webhooks);

    console.log('');
    console.log('='.repeat(50));
    console.log('Update complete!');
    console.log('='.repeat(50));
  } catch (error) {
    console.error('');
    console.error('='.repeat(50));
    console.error('Update failed:', error.message);
    console.error(error.stack);
    console.error('='.repeat(50));
    process.exit(1);
  }
}

main();
