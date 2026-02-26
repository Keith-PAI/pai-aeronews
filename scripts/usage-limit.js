#!/usr/bin/env node

/**
 * PAI AeroNews - Gemini Usage Limiter
 *
 * Tracks daily Gemini API call counts in dist/usage-counters.json
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
  return { date: utcToday(), geminiCallsToday: 0 };
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
 * Check whether `callsNeeded` more Gemini calls fit under `cap`.
 * Returns true if allowed, false if the cap would be exceeded.
 */
export function canSpendGemini(callsNeeded = 1, cap) {
  const counters = loadCounters();
  return (counters.geminiCallsToday + callsNeeded) <= cap;
}

/**
 * Record that `count` Gemini calls were made.
 * Persists immediately so the counter survives process crashes.
 */
export function recordGeminiCalls(count = 1) {
  const counters = loadCounters();
  counters.geminiCallsToday += count;
  saveCounters(counters);
  return counters.geminiCallsToday;
}

/**
 * Return the current call count for today (read-only).
 */
export function geminiCallsToday() {
  return loadCounters().geminiCallsToday;
}

/**
 * Return the remaining calls under the given cap.
 */
export function geminiCallsRemaining(cap) {
  const used = loadCounters().geminiCallsToday;
  return Math.max(0, cap - used);
}

// ── CLI test helper ──────────────────────────────────────────────
// Run directly to inspect or simulate cap-reached:
//   node scripts/usage-limit.js status
//   node scripts/usage-limit.js simulate <count>
//   node scripts/usage-limit.js reset
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename)) {
  const cmd = process.argv[2];
  const PUBLIC_CAP = parseInt(process.env.GEMINI_DAILY_CALL_CAP_PUBLIC || '900', 10);
  const ANALYST_CAP = parseInt(process.env.GEMINI_DAILY_CALL_CAP_ANALYST || '100', 10);

  if (cmd === 'status') {
    const c = loadCounters();
    console.log(`Date:            ${c.date}`);
    console.log(`Gemini calls:    ${c.geminiCallsToday}`);
    console.log(`Public cap:      ${PUBLIC_CAP}  (remaining: ${Math.max(0, PUBLIC_CAP - c.geminiCallsToday)})`);
    console.log(`Analyst cap:     ${ANALYST_CAP}  (remaining: ${Math.max(0, ANALYST_CAP - c.geminiCallsToday)})`);
  } else if (cmd === 'simulate') {
    const n = parseInt(process.argv[3], 10);
    if (isNaN(n) || n < 0) {
      console.error('Usage: node scripts/usage-limit.js simulate <count>');
      process.exit(1);
    }
    const counters = loadCounters();
    counters.geminiCallsToday = n;
    saveCounters(counters);
    console.log(`Simulated ${n} calls for ${counters.date}`);
    console.log(`Public cap (${PUBLIC_CAP}):  ${n >= PUBLIC_CAP ? 'REACHED' : 'OK'}`);
    console.log(`Analyst cap (${ANALYST_CAP}): ${n >= ANALYST_CAP ? 'REACHED' : 'OK'}`);
  } else if (cmd === 'reset') {
    saveCounters({ date: utcToday(), geminiCallsToday: 0 });
    console.log('Counters reset to 0.');
  } else {
    console.log('Usage:');
    console.log('  node scripts/usage-limit.js status              Show current counters');
    console.log('  node scripts/usage-limit.js simulate <count>    Set counter to <count>');
    console.log('  node scripts/usage-limit.js reset               Reset counters to 0');
  }
}
