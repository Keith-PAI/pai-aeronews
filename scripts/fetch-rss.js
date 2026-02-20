#!/usr/bin/env node

/**
 * PAI AeroNews - RSS Feed Fetching Script
 *
 * Fetches aviation news from RSS feeds and generates static HTML.
 * Uses Google Gemini API to generate AI takeaways (free tier).
 *
 * Usage:
 *   node scripts/fetch-rss.js
 *   GOOGLE_AI_API_KEY=xxx node scripts/fetch-rss.js
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { XMLParser } from 'fast-xml-parser';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Configuration
const CONFIG = {
  googleAiApiKey: process.env.GOOGLE_AI_API_KEY,
  teamsWebhookUrl: process.env.TEAMS_WEBHOOK_URL,
  slackWebhookUrl: process.env.SLACK_WEBHOOK_URL,
  outputDir: path.join(__dirname, '..', 'dist'),
  templatePath: path.join(__dirname, '..', 'src', 'template.html'),
  sourcesPath: path.join(__dirname, '..', 'sources.json'),
  manualPath: path.join(__dirname, '..', 'manual.json'),
  scrollDuration: 60, // seconds for full scroll cycle
};

// Category display names and colors
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
    cleaned = cleaned.substring(0, 297) + '...';
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
 * Generate AI takeaway using Google Gemini API
 */
async function generateTakeaway(article) {
  if (!CONFIG.googleAiApiKey) {
    return createFallbackTakeaway(article);
  }

  const prompt = `You are an aviation industry analyst. Given this news headline and description, write ONE sentence (max 20 words) summarizing the key takeaway for aviation professionals.

Focus on: safety implications, operational impacts, business trends, or regulatory significance.
Be concise, professional, and insightful. Do not start with "This" or "The".

Headline: ${article.headline}
Description: ${article.blurb || 'No description available'}

Takeaway:`;

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${CONFIG.googleAiApiKey}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          contents: [{
            parts: [{ text: prompt }]
          }],
          generationConfig: {
            maxOutputTokens: 100,
            temperature: 0.7,
          },
        }),
      }
    );

    const data = await response.json();

    if (data.candidates?.[0]?.content?.parts?.[0]?.text) {
      return data.candidates[0].content.parts[0].text.trim();
    }
  } catch (error) {
    console.warn(`AI takeaway failed for "${article.headline}":`, error.message);
  }

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

  // Escape content for HTML attributes (for modal data)
  const escapedHeadline = escapeHtml(article.headline);
  const escapedBlurb = escapeHtml(article.blurb);
  const escapedTakeaway = escapeHtml(article.takeaway);
  const escapedSourceName = escapeHtml(article.source.name);
  const escapedSourceUrl = escapeHtml(article.source.url);

  return `
        <div class="news-card"
             data-index="${index}"
             data-headline="${escapedHeadline}"
             data-blurb="${escapedBlurb}"
             data-takeaway="${escapedTakeaway}"
             data-source-name="${escapedSourceName}"
             data-source-url="${escapedSourceUrl}"
             data-category="${article.category}"
             data-date="${formatDateTime(article.publishedAt)}"
             onclick="openModal(this)">
          <div class="card-header">
            <span class="category-badge" style="background-color: ${categoryInfo.color}">${categoryInfo.label}</span>
            <span class="date">${date}</span>
          </div>
          <h2 class="headline">${escapedHeadline}</h2>
          <p class="blurb">${escapedBlurb}</p>
          <p class="takeaway">${escapedTakeaway}</p>
          <p class="source-link">
            See <a href="${escapedSourceUrl}" target="_blank" rel="noopener noreferrer" onclick="event.stopPropagation()">${escapedSourceName}</a> &rarr;
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
    articles: articles.map(a => ({
      id: a.id,
      headline: a.headline,
      blurb: a.blurb,
      takeaway: a.takeaway,
      source: a.source,
      category: a.category,
      keywords: a.keywords,
      publishedAt: a.publishedAt,
    })),
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

    // Limit to configured max
    const maxArticles = sources.settings?.maxArticlesInTicker || 36;
    const finalArticles = combinedArticles.slice(0, maxArticles);

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
