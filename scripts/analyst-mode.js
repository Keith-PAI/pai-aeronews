#!/usr/bin/env node

/**
 * PAI AeroNews - Analyst Mode
 *
 * Consumes dist/news-data.json, filters by SMS/safety keywords,
 * generates Gemini analyst briefs, and posts to a dedicated Teams channel.
 *
 * Zero changes to the public pipeline. Runs daily at the configured UTC hour.
 *
 * Usage:
 *   node scripts/analyst-mode.js
 *   GOOGLE_AI_API_KEY=xxx ANALYST_TEAMS_WEBHOOK_URL=yyy node scripts/analyst-mode.js
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { canSpendGemini, recordGeminiCalls, geminiCallsRemaining } from './usage-limit.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const NEWS_DATA_PATH = path.join(__dirname, '..', 'dist', 'news-data.json');
const SOURCES_PATH = path.join(__dirname, '..', 'sources.json');

// Category display names (subset from fetch-rss.js — kept separate to avoid coupling)
const CATEGORY_LABELS = {
  'general-aviation': 'General Aviation',
  'commercial': 'Commercial',
  'business-aviation': 'Business Aviation',
  'industry': 'Industry',
  'aerospace': 'Aerospace',
  'evtol': 'eVTOL',
  'drones': 'Drones',
  'electric': 'Electric',
  'regulatory': 'Regulatory',
  'safety': 'Safety',
  'military': 'Military',
  'corporate': 'Corporate',
  'international': 'International',
};

/**
 * Load and parse the analyst config from sources.json
 */
function loadAnalystConfig() {
  try {
    const data = fs.readFileSync(SOURCES_PATH, 'utf-8');
    const sources = JSON.parse(data);
    return sources.modes?.analyst || null;
  } catch (error) {
    console.error('Failed to read sources.json:', error.message);
    return null;
  }
}

/**
 * Load news-data.json produced by the public pipeline
 */
function loadNewsData() {
  try {
    const data = fs.readFileSync(NEWS_DATA_PATH, 'utf-8');
    return JSON.parse(data);
  } catch (error) {
    console.log('dist/news-data.json not found or unreadable — skipping analyst mode.');
    return null;
  }
}

/**
 * Deduplicate articles by source URL
 */
function deduplicateByUrl(articles) {
  const seen = new Set();
  return articles.filter(article => {
    const url = article.source?.url;
    if (!url || seen.has(url)) return false;
    seen.add(url);
    return true;
  });
}

/**
 * Filter articles matching analyst keywords (case-insensitive, checked against headline + blurb)
 */
function filterByKeywords(articles, keywords) {
  const lowerKeywords = keywords.map(k => k.toLowerCase());
  return articles.filter(article => {
    const text = `${article.headline || ''} ${article.blurb || ''}`.toLowerCase();
    return lowerKeywords.some(kw => text.includes(kw));
  });
}

/**
 * Extract text from a Gemini response, handling multiple response shapes defensively.
 * Supports: candidates[].content.parts[].text, output_text, and error messages.
 */
function extractGeminiText(data) {
  // Standard shape: candidates[0].content.parts[].text
  const parts = data.candidates?.[0]?.content?.parts;
  if (Array.isArray(parts)) {
    const joined = parts.map(p => p.text).filter(Boolean).join('\n');
    if (joined) return joined.trim();
  }

  // Alternative: top-level output_text (some model versions)
  if (typeof data.output_text === 'string' && data.output_text) {
    return data.output_text.trim();
  }

  // Alternative: single candidate text shorthand
  const candidateText = data.candidates?.[0]?.text;
  if (typeof candidateText === 'string' && candidateText) {
    return candidateText.trim();
  }

  return null;
}

/**
 * Generate an analyst brief for one article via Gemini
 */
async function generateAnalystBrief(article, config) {
  const apiKey = process.env.GOOGLE_AI_API_KEY;
  if (!apiKey) return null;

  const modelUrl =
    'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent';

  const prompt = `You are an aviation safety management system (SMS) analyst.
Given this article, provide a brief in this exact format:

SUMMARY: [2 concise sentences summarizing the article]

WHY THIS MATTERS TO SMS: [1 short paragraph on relevance to safety management systems]

BLOG ANGLES: [1-2 potential blog post topics for an aviation safety consulting firm]

Keep total output under 150 words.

Headline: ${article.headline}
Description: ${article.blurb || 'No description available'}`;

  let counted = false;
  try {
    const response = await fetch(
      `${modelUrl}?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            maxOutputTokens: config.geminiMaxTokens || 300,
            temperature: config.geminiTemperature ?? 0.5,
          },
        }),
        signal: AbortSignal.timeout(20000),
      }
    );

    // Record exactly once — the HTTP request consumed quota
    recordGeminiCalls(1);
    counted = true;

    if (!response.ok) {
      let bodySnippet = '';
      try {
        const raw = await response.text();
        bodySnippet = raw.substring(0, 500);
      } catch { /* ignore read errors */ }
      console.warn(`  Gemini HTTP ${response.status} for "${article.headline}"`);
      console.warn(`  Model URL: ${modelUrl}`);
      console.warn(`  GOOGLE_AI_API_KEY: ${apiKey ? 'present' : 'missing'}`);
      console.warn(`  Response body: ${bodySnippet || '(empty)'}`);
      return null;
    }

    const data = await response.json();
    const text = extractGeminiText(data);
    if (text) return text;

    // Gemini returned 200 but no usable text — log details
    const dataSnippet = JSON.stringify(data).substring(0, 500);
    console.warn(`  No usable Gemini text for "${article.headline}"`);
    console.warn(`  Model URL: ${modelUrl}`);
    console.warn(`  GOOGLE_AI_API_KEY: present`);
    console.warn(`  Parsed response: ${dataSnippet}`);
    return null;
  } catch (error) {
    if (!counted) recordGeminiCalls(1);
    console.warn(`  Gemini call failed for "${article.headline}": ${error.message}`);
    console.warn(`  Model URL: ${modelUrl}`);
    console.warn(`  GOOGLE_AI_API_KEY: ${process.env.GOOGLE_AI_API_KEY ? 'present' : 'missing'}`);
    return null;
  }
}

/**
 * Build a Teams Adaptive Card for the analyst digest
 */
function buildAnalystTeamsCard(articles) {
  const today = new Date().toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });

  const articleRows = articles.map(article => {
    const categoryLabel = CATEGORY_LABELS[article.category] || 'News';
    const briefItems = article.analystBrief
      ? [{
          type: 'TextBlock',
          text: article.analystBrief,
          wrap: true,
          size: 'small',
          spacing: 'small',
        }]
      : [];

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
                text: categoryLabel,
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
        ...briefItems,
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
            text: '🛡️ PAI AeroNews — SMS Analyst Digest',
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
            text: `${articles.length} safety-relevant article${articles.length === 1 ? '' : 's'} found`,
            size: 'small',
            isSubtle: true,
          },
          ...articleRows,
          {
            type: 'TextBlock',
            text: '_Internal — PAI Consulting Safety Analytics_',
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
  console.log('PAI AeroNews — Analyst Mode');
  console.log('='.repeat(40));

  // 1. Load analyst config
  const config = loadAnalystConfig();
  if (!config || !config.enabled) {
    console.log('Analyst mode is not enabled. Exiting.');
    process.exit(0);
  }

  // 2. Schedule gate
  const currentHourUTC = new Date().getUTCHours();
  const targetHour = config.dailyHourUTC ?? 12;
  if (currentHourUTC !== targetHour) {
    console.log(`Not analyst digest hour (current: ${currentHourUTC} UTC, target: ${targetHour} UTC). Skipping.`);
    process.exit(0);
  }

  // 3. Load news data
  const newsData = loadNewsData();
  if (!newsData || !newsData.articles || newsData.articles.length === 0) {
    console.log('No articles in news-data.json. Exiting.');
    process.exit(0);
  }

  console.log(`Loaded ${newsData.articles.length} articles from news-data.json`);

  // 4. Deduplicate
  const deduped = deduplicateByUrl(newsData.articles);
  console.log(`After deduplication: ${deduped.length} articles`);

  // 5. Filter by keywords
  const filtered = filterByKeywords(deduped, config.keywords || []);
  if (filtered.length === 0) {
    console.log('No articles matched analyst keywords. Exiting.');
    process.exit(0);
  }

  // 5b. Sort newest first, cap at maxArticles
  filtered.sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));
  const capped = filtered.slice(0, config.maxArticles || 10);
  console.log(`${capped.length} articles matched keywords (capped from ${filtered.length})`);

  // 6. Generate analyst briefs (with daily cap enforcement)
  const ANALYST_CAP = parseInt(process.env.GEMINI_DAILY_CALL_CAP_ANALYST || '100', 10);
  let capReached = false;

  if (!process.env.GOOGLE_AI_API_KEY) {
    console.warn('No GOOGLE_AI_API_KEY set — skipping Gemini analyst briefs.');
  } else if (!canSpendGemini(1, ANALYST_CAP)) {
    const remaining = geminiCallsRemaining(ANALYST_CAP);
    console.warn(`⚠ GEMINI DAILY CAP REACHED (analyst cap: ${ANALYST_CAP}, remaining: ${remaining}). Skipping analyst briefs.`);
    capReached = true;
  } else {
    console.log(`\nGenerating analyst briefs via Gemini (cap: ${ANALYST_CAP}, remaining: ${geminiCallsRemaining(ANALYST_CAP)})...`);
    for (const article of capped) {
      // Re-check cap before each call (public pipeline may have used calls too)
      if (!canSpendGemini(1, ANALYST_CAP)) {
        console.warn(`⚠ GEMINI DAILY CAP REACHED mid-loop (analyst cap: ${ANALYST_CAP}). Skipping remaining briefs.`);
        capReached = true;
        break;
      }
      const brief = await generateAnalystBrief(article, config);
      article.analystBrief = brief;
      const status = brief ? '✓' : '✗';
      console.log(`  ${status} ${article.headline.substring(0, 60)}...`);
    }
  }

  if (capReached) {
    console.log('Digest will be posted without AI briefs (cap reached).');
  }

  // 7. Check for webhook URL
  const webhookEnvVar = config.teamsWebhookEnvVar || 'ANALYST_TEAMS_WEBHOOK_URL';
  const webhookUrl = process.env[webhookEnvVar];
  if (!webhookUrl) {
    console.log(`\nNo ${webhookEnvVar} configured — skipping Teams post.`);
    console.log('Analyst briefs generated successfully (no delivery target).');
    process.exit(0);
  }

  // 8. Build and send Teams card
  console.log('\nPosting analyst digest to Teams...');
  try {
    const payload = buildAnalystTeamsCard(capped);
    await postToTeams(webhookUrl, payload);
    console.log('✓ Analyst digest posted to Teams successfully.');
  } catch (error) {
    console.warn(`✗ Failed to post to Teams: ${error.message}`);
    console.warn('Teams delivery failed — check webhook URL/secret. Exiting gracefully.');
  }

  console.log('\n' + '='.repeat(40));
  console.log('Analyst mode complete.');
}

main();
