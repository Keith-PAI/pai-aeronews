#!/usr/bin/env node

/**
 * PAI AeroNews - Opportunity Spotter
 *
 * Reads articles from dist/news-data.json, filters out URLs already processed
 * in prior runs (tracked in dist/os-seen-urls.json), and — if any new articles
 * remain — sends them to Claude in a single API call to surface up to 7 ranked
 * content/tool opportunities for PAI Consulting. Posts results to Teams via
 * BLOG_TEAMS_WEBHOOK_URL.
 *
 * Designed to run as a step inside the hourly update-news job. Skips the
 * Claude call entirely when there are no new URLs since the last run.
 * Failures are non-fatal — never break the public pipeline.
 *
 * Usage:
 *   node scripts/opportunity-spotter.js
 *   ANTHROPIC_API_KEY=xxx BLOG_TEAMS_WEBHOOK_URL=yyy node scripts/opportunity-spotter.js
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { canSpendClaude, recordClaudeCalls, claudeCallsRemaining } from './usage-limit.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const NEWS_DATA_PATH = path.join(__dirname, '..', 'dist', 'news-data.json');
const SEEN_URLS_PATH = path.join(__dirname, '..', 'dist', 'os-seen-urls.json');
const SEEN_URLS_MAX = 500; // FIFO cap to keep the file bounded
const OPPORTUNITY_CAP = parseInt(process.env.CLAUDE_DAILY_CALL_CAP_OPPORTUNITY || '30', 10);
const OPPORTUNITY_COUNTER_KEY = 'opportunityCallsToday';

/**
 * Load news-data.json produced by the public pipeline
 */
function loadNewsData() {
  try {
    const data = fs.readFileSync(NEWS_DATA_PATH, 'utf-8');
    return JSON.parse(data);
  } catch (error) {
    console.log('dist/news-data.json not found or unreadable — skipping opportunity spotter.');
    return null;
  }
}

/**
 * Load the set of article URLs that the OS has already processed in past runs.
 * Missing/unreadable file → empty set (first run, graceful degradation).
 */
function loadSeenUrls() {
  try {
    const raw = fs.readFileSync(SEEN_URLS_PATH, 'utf-8');
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed.urls)) return new Set(parsed.urls);
    return new Set();
  } catch (error) {
    return new Set();
  }
}

/**
 * Persist the seen-URLs set to dist/os-seen-urls.json. The set is trimmed
 * (FIFO) to SEEN_URLS_MAX entries so the file stays bounded over months.
 */
function saveSeenUrls(seenSet) {
  try {
    const urls = Array.from(seenSet);
    const trimmed = urls.length > SEEN_URLS_MAX
      ? urls.slice(urls.length - SEEN_URLS_MAX)
      : urls;
    const payload = {
      updatedAt: new Date().toISOString(),
      count: trimmed.length,
      urls: trimmed,
    };
    fs.writeFileSync(SEEN_URLS_PATH, JSON.stringify(payload, null, 2));
  } catch (error) {
    console.warn(`Failed to write os-seen-urls.json: ${error.message}`);
  }
}

/**
 * Extract text from a Claude API response
 */
function extractClaudeText(data) {
  if (Array.isArray(data.content)) {
    const joined = data.content.map(b => b.text).filter(Boolean).join('\n');
    if (joined) return joined.trim();
  }
  return null;
}

/**
 * Load PAI wiki context files if the private wiki was cloned alongside this repo.
 * Returns concatenated markdown or empty string. Never throws — wiki is optional.
 */
function loadWikiContext() {
  const wikiDir = path.join(__dirname, '..', 'pai-wiki-context', 'wiki');
  const files = ['index.md', 'pai-overview.md', 'pai-services.md', 'pai-clients.md', 'opportunities-log.md'];
  const parts = [];
  for (const f of files) {
    try {
      const p = path.join(wikiDir, f);
      if (fs.existsSync(p)) {
        parts.push(`### ${f}\n${fs.readFileSync(p, 'utf-8')}`);
      }
    } catch {
      // ignore — wiki context is best-effort
    }
  }
  return parts.join('\n\n');
}

/**
 * Build a compact summary of articles for the Claude prompt
 */
function buildArticleSummary(articles) {
  return articles.map((a, i) =>
    `${i + 1}. [${a.category || 'news'}] ${a.headline} (${a.source?.url || 'no link'})\n   ${a.blurb || 'No description'}\n   Source: ${a.source?.name || 'Unknown'}`
  ).join('\n\n');
}

/**
 * Send all articles to Claude in a single API call and get opportunity ideas
 */
async function generateOpportunities(articles) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;

  const articleSummary = buildArticleSummary(articles);
  const wikiContext = loadWikiContext();
  const wikiSection = wikiContext
    ? `## PAI Knowledge Base Context\n${wikiContext}\n\n## Articles to Analyze\n\n`
    : '';

  const prompt = `${wikiSection}PAI Consulting is an aviation SMS (Safety Management System) and safety consulting firm. Based on these news articles, surface up to 7 specific opportunities for PAI to create a useful web tool, app widget, or blog post that would be timely and relevant to their clients.

**PAI's core services:** SMS implementation, safety program development, regulatory compliance consulting, aviation document editing, and meeting/conference support. Opportunities should connect directly to one of these.

**What makes a strong opportunity.** A strong opportunity meets at least one of these criteria: (1) there is a regulatory deadline or comment period approaching, (2) a safety incident or investigation has just been reported that operators need to respond to, (3) a new rule, guidance, or requirement has been published that PAI's clients must understand, (4) an emerging trend creates a clear gap that a PAI tool or blog post could fill. A weak opportunity is general industry news with no clear PAI angle. When in doubt, surface it with a 🔵 Watch This tier rather than skipping it.

Rank the opportunities by urgency, most time-sensitive first. If fewer than 3 genuinely strong opportunities exist in these articles, surface only the real ones — do not pad the list with weak items just to hit 7. Quality over quantity.

For each opportunity, include all of the following:

- **Headline** — a short title for the opportunity
- **Tier** — exactly one of: 🔴 Act Now / 🟡 Strong Lead / 🔵 Watch This
- **Why Now** — one sentence explaining the urgency or timing window (e.g., "FAA comment period closes Thursday" or "Story broke this morning — high visibility window while the topic is trending")
- **First Step** — one concrete sentence suggesting the immediate action PAI could take (e.g., "Draft a 400-word LinkedIn post today" or "Build a readiness checklist tool for Part 141 schools")
- **Opportunity description** — what the tool, widget, or post would actually do, specific enough to act on
- **Inspired by** — citation(s) to the source article(s)

For each "Inspired by" citation, format the article title as a markdown link using the URL provided in parentheses, like: [Article Title](https://...). Do not include bare URLs.

**Output rules (strict):**
- Output ONLY the opportunities themselves in the format described above. Do NOT include any explanation or reasoning about articles that did not qualify.
- Do NOT include a "Non-Opportunities" section, a summary paragraph, preamble, or any text explaining why articles were skipped.
- If zero articles qualify, output only the single word NONE and nothing else.
- Do NOT analyze or generate opportunities for any article whose URL contains paiconsulting.com. Treat PAI's own content as context-only background — it must never appear as an opportunity.

New articles since the last opportunity scan:

${articleSummary}`;

  let counted = false;
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1500,
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: AbortSignal.timeout(30000),
    });

    // Record exactly once — the HTTP request consumed quota
    recordClaudeCalls(1, OPPORTUNITY_COUNTER_KEY);
    counted = true;

    if (!response.ok) {
      let bodySnippet = '';
      try {
        const raw = await response.text();
        bodySnippet = raw.substring(0, 500);
      } catch { /* ignore read errors */ }
      console.warn(`Claude HTTP ${response.status}`);
      console.warn(`  Response body: ${bodySnippet || '(empty)'}`);
      return null;
    }

    const data = await response.json();
    const text = extractClaudeText(data);
    if (text) return text;

    console.warn('Claude returned 200 but no usable text.');
    return null;
  } catch (error) {
    if (!counted) recordClaudeCalls(1, OPPORTUNITY_COUNTER_KEY);
    console.warn(`Claude call failed: ${error.message}`);
    return null;
  }
}

/**
 * Build a Teams Adaptive Card for the opportunity spotter
 */
function buildTeamsCard(opportunityText, articleCount) {
  const today = new Date().toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
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
            text: '💡 PAI AeroNews — Opportunity Spotter',
            size: 'large',
            weight: 'bolder',
            color: 'accent',
          },
          {
            type: 'TextBlock',
            text: '🕐 Hourly · new opportunities only',
            size: 'small',
            isSubtle: true,
            spacing: 'none',
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
            text: `Based on ${articleCount} new article${articleCount === 1 ? '' : 's'} since last run`,
            size: 'small',
            isSubtle: true,
          },
          {
            type: 'TextBlock',
            text: opportunityText,
            wrap: true,
            size: 'default',
            spacing: 'medium',
          },
          {
            type: 'TextBlock',
            text: '_Internal — PAI Consulting Content Strategy_',
            size: 'small',
            isSubtle: true,
            spacing: 'large',
            horizontalAlignment: 'right',
          },
        ],
      },
    }],
  };
}

/**
 * Post payload to a Teams webhook
 */
async function postToTeams(webhookUrl, payload) {
  const response = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(15000),
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }
}

/**
 * Main
 */
async function main() {
  console.log('PAI AeroNews — Opportunity Spotter');
  console.log('='.repeat(40));

  // 1. Check for API key
  if (!process.env.ANTHROPIC_API_KEY) {
    console.log('No ANTHROPIC_API_KEY set — skipping opportunity spotter.');
    process.exit(0);
  }

  // 3. Load news data
  const newsData = loadNewsData();
  if (!newsData || !newsData.articles || newsData.articles.length === 0) {
    console.log('No articles in news-data.json. Exiting.');
    process.exit(0);
  }

  console.log(`Loaded ${newsData.articles.length} articles from news-data.json`);

  // 4. Filter against the seen-URLs set — only analyze new articles.
  const seen = loadSeenUrls();
  console.log(`Loaded ${seen.size} previously-seen article URLs`);

  const newArticles = newsData.articles.filter(a => {
    const url = a.source?.url;
    return url && !seen.has(url);
  });

  if (newArticles.length === 0) {
    console.log('No new articles since last OS run — skipping Claude call.');
    process.exit(0);
  }

  console.log(`Found ${newArticles.length} new article${newArticles.length === 1 ? '' : 's'} to analyze`);

  // 5. Check Claude daily cap (one call needed — independent counter)
  if (!canSpendClaude(1, OPPORTUNITY_CAP, OPPORTUNITY_COUNTER_KEY)) {
    const remaining = claudeCallsRemaining(OPPORTUNITY_CAP, OPPORTUNITY_COUNTER_KEY);
    console.warn(`⚠ CLAUDE DAILY CAP REACHED (opportunity cap: ${OPPORTUNITY_CAP}, remaining: ${remaining}). Exiting without marking URLs as seen so they're picked up after the counter resets.`);
    process.exit(0);
  }

  console.log(`Claude cap OK (remaining: ${claudeCallsRemaining(OPPORTUNITY_CAP, OPPORTUNITY_COUNTER_KEY)})`);

  // 6. Generate opportunities (single API call against the new articles only)
  console.log('\nSending new articles to Claude for opportunity analysis...');
  const opportunities = await generateOpportunities(newArticles);

  if (!opportunities) {
    console.warn('No opportunity ideas generated. Exiting without marking URLs as seen.');
    process.exit(0);
  }

  console.log('✓ Opportunities generated');

  // 6b. Post raw, unfiltered Claude response to debug webhook (if configured).
  // Fires regardless of whether opportunities were found.
  const debugWebhookUrl = process.env.OS_DEBUG_WEBHOOK_URL;
  if (debugWebhookUrl) {
    try {
      const debugPayload = {
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
                text: 'OS Debug — Raw Analysis',
                size: 'large',
                weight: 'bolder',
              },
              {
                type: 'TextBlock',
                text: opportunities,
                wrap: true,
              },
            ],
          },
        }],
      };
      await postToTeams(debugWebhookUrl, debugPayload);
      console.log('✓ Posted raw response to OS_DEBUG_WEBHOOK_URL');
    } catch (error) {
      console.warn(`✗ Failed to post debug webhook: ${error.message}`);
    }
  }

  // If Claude returned NONE (no qualifying opportunities), skip the main post.
  if (opportunities.trim().toUpperCase() === 'NONE') {
    console.log('Claude returned NONE — no qualifying opportunities. Skipping main Teams post.');
    for (const a of newArticles) {
      if (a.source?.url) seen.add(a.source.url);
    }
    saveSeenUrls(seen);
    console.log(`✓ Marked ${newArticles.length} URL(s) as seen (total tracked: ${seen.size})`);
    process.exit(0);
  }

  // 7. Mark new URLs as seen — persist regardless of whether the Teams post
  // succeeds. We've already paid for the Claude call; re-processing the same
  // articles next hour would waste quota.
  for (const a of newArticles) {
    if (a.source?.url) seen.add(a.source.url);
  }
  saveSeenUrls(seen);
  console.log(`✓ Marked ${newArticles.length} URL(s) as seen (total tracked: ${seen.size})`);

  // 8. Check for webhook URL
  const webhookUrl = process.env.BLOG_TEAMS_WEBHOOK_URL;
  if (!webhookUrl) {
    console.log('\nNo BLOG_TEAMS_WEBHOOK_URL configured — printing to console instead.');
    console.log('\n' + opportunities);
    process.exit(0);
  }

  // 9. Post to Teams
  console.log('\nPosting opportunities to Teams...');
  try {
    const payload = buildTeamsCard(opportunities, newArticles.length);
    await postToTeams(webhookUrl, payload);
    console.log('✓ Opportunity spotter posted to Teams successfully.');
  } catch (error) {
    console.warn(`✗ Failed to post to Teams: ${error.message}`);
    console.warn('Teams delivery failed — exiting gracefully.');
  }

  console.log('\n' + '='.repeat(40));
  console.log('Opportunity spotter complete.');
}

main();
