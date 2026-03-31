#!/usr/bin/env node

/**
 * PAI AeroNews - Claude API Usage Limiter
 *
 * Tracks daily Anthropic Claude API call counts in dist/usage-counters.json
 * and enforces hard caps to prevent cost spikes from loop bugs.
 *
 * Counter resets automatically each UTC day (YYYY-MM-DD boundary).
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const COUNTERS_PATH = path.join(__dirname, '..', 'dist', 'usage-counters.json');

/**
 * Get today's UTC date string (YYYY-MM-DD)
 */
function utcToday() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Load counters from disk, creating a fresh file if missing or corrupted.
 * Resets counters when the UTC date rolls over.
 */
function loadCounters() {
  try {
    const raw = fs.readFileSync(COUNTERS_PATH, 'utf-8');
    const data = JSON.parse(raw);
    if (data.date === utcToday()) {
      return data;
    }
    // Date rolled over — reset
  } catch {
    // File missing or corrupted — start fresh
  }
  return { date: utcToday(), claudeCallsToday: 0 };
}

/**
 * Persist counters to disk.
 */
function saveCounters(counters) {
  const dir = path.dirname(COUNTERS_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(COUNTERS_PATH, JSON.stringify(counters, null, 2), 'utf-8');
}

/**
 * Check whether `callsNeeded` more Claude API calls fit under `cap`.
 * Returns true if allowed, false if the cap would be exceeded.
 *
 * @param {number} callsNeeded
 * @param {number} cap
 * @param {string} [counterKey='claudeCallsToday'] - Counter field name for independent tracking
 */
export function canSpendClaude(callsNeeded = 1, cap, counterKey = 'claudeCallsToday') {
  const counters = loadCounters();
  const used = counters[counterKey] || 0;
  return (used + callsNeeded) <= cap;
}

/**
 * Record that `count` Claude API calls were made.
 * Persists immediately so the counter survives process crashes.
 *
 * @param {number} count
 * @param {string} [counterKey='claudeCallsToday'] - Counter field name for independent tracking
 */
export function recordClaudeCalls(count = 1, counterKey = 'claudeCallsToday') {
  const counters = loadCounters();
  counters[counterKey] = (counters[counterKey] || 0) + count;
  saveCounters(counters);
  return counters[counterKey];
}

/**
 * Return the current call count for today (read-only).
 *
 * @param {string} [counterKey='claudeCallsToday'] - Counter field name for independent tracking
 */
export function claudeCallsToday(counterKey = 'claudeCallsToday') {
  return loadCounters()[counterKey] || 0;
}

/**
 * Return the remaining calls under the given cap.
 *
 * @param {number} cap
 * @param {string} [counterKey='claudeCallsToday'] - Counter field name for independent tracking
 */
export function claudeCallsRemaining(cap, counterKey = 'claudeCallsToday') {
  const used = loadCounters()[counterKey] || 0;
  return Math.max(0, cap - used);
}

// ── CLI test helper ──────────────────────────────────────────────
// Run directly to inspect or simulate cap-reached:
//   node scripts/usage-limit.js status
//   node scripts/usage-limit.js simulate <count>
//   node scripts/usage-limit.js reset
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename)) {
  const cmd = process.argv[2];
  const PUBLIC_CAP = parseInt(process.env.CLAUDE_DAILY_CALL_CAP_PUBLIC || '900', 10);
  const ANALYST_CAP = parseInt(process.env.CLAUDE_DAILY_CALL_CAP_ANALYST || '100', 10);
  const OPPORTUNITY_CAP = parseInt(process.env.CLAUDE_DAILY_CALL_CAP_OPPORTUNITY || '10', 10);

  if (cmd === 'status') {
    const c = loadCounters();
    console.log(`Date:              ${c.date}`);
    console.log(`Public calls:      ${c.claudeCallsToday || 0}  (cap: ${PUBLIC_CAP}, remaining: ${Math.max(0, PUBLIC_CAP - (c.claudeCallsToday || 0))})`);
    console.log(`Analyst calls:     ${c.analystCallsToday || 0}  (cap: ${ANALYST_CAP}, remaining: ${Math.max(0, ANALYST_CAP - (c.analystCallsToday || 0))})`);
    console.log(`Opportunity calls: ${c.opportunityCallsToday || 0}  (cap: ${OPPORTUNITY_CAP}, remaining: ${Math.max(0, OPPORTUNITY_CAP - (c.opportunityCallsToday || 0))})`);
  } else if (cmd === 'simulate') {
    const n = parseInt(process.argv[3], 10);
    if (isNaN(n) || n < 0) {
      console.error('Usage: node scripts/usage-limit.js simulate <count>');
      process.exit(1);
    }
    const counters = loadCounters();
    counters.claudeCallsToday = n;
    saveCounters(counters);
    console.log(`Simulated ${n} calls for ${counters.date}`);
    console.log(`Public cap (${PUBLIC_CAP}):  ${n >= PUBLIC_CAP ? 'REACHED' : 'OK'}`);
    console.log(`Analyst cap (${ANALYST_CAP}): ${n >= ANALYST_CAP ? 'REACHED' : 'OK'}`);
  } else if (cmd === 'reset') {
    saveCounters({ date: utcToday(), claudeCallsToday: 0 });
    console.log('Counters reset to 0.');
  } else {
    console.log('Usage:');
    console.log('  node scripts/usage-limit.js status              Show current counters');
    console.log('  node scripts/usage-limit.js simulate <count>    Set counter to <count>');
    console.log('  node scripts/usage-limit.js reset               Reset counters to 0');
  }
}
