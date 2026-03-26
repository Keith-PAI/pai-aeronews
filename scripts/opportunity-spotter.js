#!/usr/bin/env node

/**
 * PAI AeroNews - Opportunity Spotter
 *
 * Reads today's articles from dist/news-data.json, sends them to Claude in a
 * single API call to identify 2-3 actionable content or tool ideas for PAI
 * Consulting, and posts the result to a Teams channel via webhook.
 *
 * Zero changes to the public pipeline. Runs daily at noon UTC.
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
const ANALYST_CAP = parseInt(process.env.CLAUDE_DAILY_CALL_CAP_ANALYST || '100', 10);

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
 * Build a compact summary of articles for the Claude prompt
 */
function buildArticleSummary(articles) {
  return articles.map((a, i) =>
    `${i + 1}. [${a.category || 'news'}] ${a.headline}\n   ${a.blurb || 'No description'}\n   Source: ${a.source?.name || 'Unknown'}`
  ).join('\n\n');
}

/**
 * Send all articles to Claude in a single API call and get opportunity ideas
 */
async function generateOpportunities(articles) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;

  const articleSummary = buildArticleSummary(articles);

  const prompt = `PAI Consulting is an aviation SMS (Safety Management System) and safety consulting firm. Based on these news articles, identify 2-3 specific opportunities for PAI to create a useful web tool, app widget, or blog post that would be timely and relevant to their clients. Be specific — name the article that inspired the idea and describe what the tool or post would do.

Today's articles:

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
        max_tokens: 600,
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: AbortSignal.timeout(30000),
    });

    // Record exactly once — the HTTP request consumed quota
    recordClaudeCalls(1);
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
    if (!counted) recordClaudeCalls(1);
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
            text: today,
            size: 'small',
            isSubtle: true,
            spacing: 'none',
          },
          {
            type: 'TextBlock',
            text: `Based on ${articleCount} article${articleCount === 1 ? '' : 's'} in today's feed`,
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

  // 1. Schedule gate
  const forceNow = !!process.env.OPPORTUNITY_FORCE_NOW;
  if (!forceNow) {
    const currentHourUTC = new Date().getUTCHours();
    const targetHour = 12; // noon UTC
    if (currentHourUTC !== targetHour) {
      console.log(`Not opportunity spotter hour (current: ${currentHourUTC} UTC, target: ${targetHour} UTC). Skipping.`);
      process.exit(0);
    }
  } else {
    console.log('OPPORTUNITY_FORCE_NOW set — bypassing schedule gate.');
  }

  // 2. Check for API key
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

  // 4. Check Claude daily cap (one call needed)
  if (!canSpendClaude(1, ANALYST_CAP)) {
    const remaining = claudeCallsRemaining(ANALYST_CAP);
    console.warn(`⚠ CLAUDE DAILY CAP REACHED (analyst cap: ${ANALYST_CAP}, remaining: ${remaining}). Exiting.`);
    process.exit(0);
  }

  console.log(`Claude cap OK (remaining: ${claudeCallsRemaining(ANALYST_CAP)})`);

  // 5. Generate opportunities (single API call)
  console.log('\nSending articles to Claude for opportunity analysis...');
  const opportunities = await generateOpportunities(newsData.articles);

  if (!opportunities) {
    console.warn('No opportunity ideas generated. Exiting.');
    process.exit(0);
  }

  console.log('✓ Opportunities generated');

  // 6. Check for webhook URL
  const webhookUrl = process.env.BLOG_TEAMS_WEBHOOK_URL;
  if (!webhookUrl) {
    console.log('\nNo BLOG_TEAMS_WEBHOOK_URL configured — printing to console instead.');
    console.log('\n' + opportunities);
    process.exit(0);
  }

  // 7. Post to Teams
  console.log('\nPosting opportunities to Teams...');
  try {
    const payload = buildTeamsCard(opportunities, newsData.articles.length);
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
