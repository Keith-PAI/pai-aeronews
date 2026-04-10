/**
 * PAI Company Radar
 *
 * Daily competitor and brand intelligence digest. Reads a fixed set of
 * Google Alerts Atom feeds, deduplicates against dist/company-radar-seen.json,
 * groups any new items by feed label, and posts a Microsoft Teams Adaptive
 * Card to COMPANY_RADAR_TEAMS_WEBHOOK_URL.
 *
 * No Anthropic API calls — pure RSS aggregation.
 *
 * Skip rules:
 *   - Missing webhook secret → exit 0 with a log line
 *   - No new items across all feeds → exit 0, no Teams post
 *   - Per-feed fetch failures → log and continue
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { XMLParser } from 'fast-xml-parser';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SEEN_PATH = path.join(__dirname, '..', 'dist', 'company-radar-seen.json');
const SEEN_MAX = 2000;

const FEEDS = [
  { label: 'aviation SMS consulting',          url: 'https://www.google.com/alerts/feeds/04019711336603618986/5712931456466898922' },
  { label: 'FAA SMS Part 5',                   url: 'https://www.google.com/alerts/feeds/04019711336603618986/17922080549659896281' },
  { label: 'Anthropic government',             url: 'https://www.google.com/alerts/feeds/04019711336603618986/5220783898108369582' },
  { label: 'Phaneuf Associates Incorporated',  url: 'https://www.google.com/alerts/feeds/04019711336603618986/12342184131598101028' },
  { label: 'PAI Consulting',                   url: 'https://www.google.com/alerts/feeds/04019711336603618986/17659440467157142200' },
];

const WEBHOOK_URL = process.env.COMPANY_RADAR_TEAMS_WEBHOOK_URL;

function loadSeen() {
  try {
    const raw = fs.readFileSync(SEEN_PATH, 'utf-8');
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed.urls)) return new Set(parsed.urls);
  } catch {}
  return new Set();
}

function saveSeen(seenSet) {
  try {
    const urls = Array.from(seenSet);
    const trimmed = urls.length > SEEN_MAX ? urls.slice(urls.length - SEEN_MAX) : urls;
    const payload = {
      updatedAt: new Date().toISOString(),
      count: trimmed.length,
      urls: trimmed,
    };
    fs.mkdirSync(path.dirname(SEEN_PATH), { recursive: true });
    fs.writeFileSync(SEEN_PATH, JSON.stringify(payload, null, 2));
  } catch (err) {
    console.warn(`Failed to write company-radar-seen.json: ${err.message}`);
  }
}

/**
 * Google Alerts wraps the real article URL in a redirect like
 * https://www.google.com/url?...&url=<encoded>&...
 * Unwrap to the canonical URL when possible so dedup is stable.
 */
function unwrapGoogleUrl(href) {
  if (!href) return href;
  try {
    const u = new URL(href);
    const inner = u.searchParams.get('url');
    if (inner) return inner;
  } catch {}
  return href;
}

function stripHtml(s) {
  if (!s) return '';
  return String(s).replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
}

async function fetchFeed(feed) {
  const res = await fetch(feed.url, {
    headers: { 'User-Agent': 'PAI-Company-Radar/1.0' },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const xml = await res.text();
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
  });
  const parsed = parser.parse(xml);

  const root = parsed.feed || {};
  const sourceName = stripHtml(root.title?.['#text'] || root.title || feed.label);
  let entries = root.entry || [];
  if (!Array.isArray(entries)) entries = [entries];

  return entries.map(e => {
    let link = '';
    if (Array.isArray(e.link)) {
      link = e.link[0]?.['@_href'] || '';
    } else if (e.link) {
      link = e.link['@_href'] || e.link.href || e.link || '';
    }
    return {
      title: stripHtml(e.title?.['#text'] || e.title),
      url: unwrapGoogleUrl(link),
      published: e.published || e.updated || '',
      source: sourceName,
    };
  }).filter(item => item.url && item.title);
}

function formatDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

function buildAdaptiveCard(grouped, todayLabel) {
  const body = [
    {
      type: 'TextBlock',
      text: `🎯 PAI Company Radar — ${todayLabel}`,
      weight: 'Bolder',
      size: 'Large',
      wrap: true,
    },
  ];

  for (const { label, items } of grouped) {
    body.push({
      type: 'TextBlock',
      text: label,
      weight: 'Bolder',
      size: 'Medium',
      separator: true,
      spacing: 'Medium',
      wrap: true,
    });
    for (const item of items) {
      const date = formatDate(item.published);
      const meta = [item.source, date].filter(Boolean).join(' • ');
      body.push({
        type: 'TextBlock',
        text: `[${item.title}](${item.url})`,
        wrap: true,
        spacing: 'Small',
      });
      if (meta) {
        body.push({
          type: 'TextBlock',
          text: meta,
          isSubtle: true,
          size: 'Small',
          spacing: 'None',
          wrap: true,
        });
      }
    }
  }

  return {
    type: 'message',
    attachments: [
      {
        contentType: 'application/vnd.microsoft.card.adaptive',
        contentUrl: null,
        content: {
          $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
          type: 'AdaptiveCard',
          version: '1.4',
          body,
        },
      },
    ],
  };
}

async function postToTeams(card) {
  const res = await fetch(WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(card),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Teams webhook ${res.status}: ${text}`);
  }
}

async function main() {
  if (!WEBHOOK_URL) {
    console.log('COMPANY_RADAR_TEAMS_WEBHOOK_URL not set — skipping Company Radar.');
    return;
  }

  const seen = loadSeen();
  const grouped = [];
  let totalNew = 0;

  for (const feed of FEEDS) {
    try {
      const items = await fetchFeed(feed);
      const fresh = items.filter(it => !seen.has(it.url));
      if (fresh.length > 0) {
        grouped.push({ label: feed.label, items: fresh });
        totalNew += fresh.length;
      }
      console.log(`  ${feed.label}: ${items.length} total, ${fresh.length} new`);
    } catch (err) {
      console.warn(`  ${feed.label}: fetch failed — ${err.message}`);
    }
  }

  if (totalNew === 0) {
    console.log('No new items across any feed — skipping Teams post.');
    return;
  }

  const todayLabel = new Date().toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
  });
  const card = buildAdaptiveCard(grouped, todayLabel);

  try {
    await postToTeams(card);
    console.log(`✓ Posted Company Radar with ${totalNew} new item(s) across ${grouped.length} feed(s).`);
  } catch (err) {
    console.warn(`Teams post failed: ${err.message} — leaving seen-URLs unchanged.`);
    return;
  }

  // Mark new URLs as seen only after a successful post (matches OS pattern).
  for (const { items } of grouped) {
    for (const it of items) seen.add(it.url);
  }
  saveSeen(seen);
  console.log(`✓ Updated company-radar-seen.json (total tracked: ${seen.size})`);
}

main().catch(err => {
  console.error('Company Radar fatal error:', err);
  process.exit(0); // never break the workflow
});
