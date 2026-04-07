# PAI AeroNews — Major Expansion Architecture Plan

## 0. Executive Summary

You're proposing five additions that, taken together, transform PAI AeroNews from a hourly news scroller plus three independent internal digests into a **decision-support system for PAI Consulting's content and product pipeline**:

1. **Consolidated Daily Brief** — replaces analyst + OS internal cards with one tiered card.
2. **Four new data sources** (two are RSS, two are richer APIs).
3. **SharePoint as system of record** for every opportunity surfaced.
4. **Power Automate action buttons** turning each opportunity into a one-click workflow.
5. **Orchestrator** that links new opportunities to past apps/content via SharePoint history.

The single most important constraint is in CLAUDE.md: **the public pipeline (`fetch-rss.js` → `dist/index.html` → gh-pages) is frozen.** Phase 1 of this plan exists solely to keep everything currently working untouched while new components are built alongside.

I'm also flagging one tension up front: you said "one card replacing the current three separate outputs," but the three current outputs target three different Teams channels (`TEAMS_WEBHOOK_URL` = public/brand voice, `ANALYST_TEAMS_WEBHOOK_URL` = safety analytics, `BLOG_TEAMS_WEBHOOK_URL` = content strategy). I'll address this in §4.1 with a recommendation, but you'll need to make the call.

---

## 1. Current State Recap (so the plan is anchored to reality)

```
Hourly cron (0 * * * *)
        │
        ▼
update-news job ──► fetch-rss.js
                    ├─ 17 RSS feeds (sources.json)
                    ├─ manual.json (high-priority breaking)
                    ├─ pai-content-library.json (blogs, videos, curated)
                    ├─ Claude takeaways (cap: 900/day, counter: claudeCallsToday)
                    ├─ Writes dist/index.html, dist/news-data.json
                    ├─ Daily digest @ 10:00 UTC → TEAMS_WEBHOOK_URL + SLACK
                    └─ Pushed to gh-pages → GitHub Pages → Squarespace iframe

Daily cron (0 10 * * *)
        │
        ▼
opportunity-spotter job ──► opportunity-spotter.js
                            ├─ Reads dist/news-data.json (from gh-pages)
                            ├─ ONE Claude call asking for 2-3 opportunities
                            │   (cap: 10/day, counter: opportunityCallsToday)
                            └─ Posts Adaptive Card → BLOG_TEAMS_WEBHOOK_URL

Weekly cron (0 10 * * 1)
        │
        ▼
analyst-digest job ──► analyst-mode.js
                       ├─ Reads dist/news-data.json
                       ├─ Filters by safety keywords
                       ├─ N Claude calls (1 per article, cap: 100/day,
                       │   counter: analystCallsToday)
                       ├─ Internal hour gate at line 343 ⚠ (still present)
                       └─ Posts Adaptive Card → ANALYST_TEAMS_WEBHOOK_URL

Persistent state:
  - dist/news-data.json (ephemeral, regenerated hourly)
  - dist/usage-counters.json (per-job Claude call counts, UTC daily reset)
  - pai-content-library.json (the only file allowed to be edited on main)
```

Constraints baked into CLAUDE.md that this plan respects:
- Public pipeline frozen.
- All Claude calls guarded by `canSpendClaude()`, recorded exactly once per HTTP attempt.
- Internal modes are daily, not hourly.
- Missing secret = silent exit 0.
- `main` is PR-only (except content library).
- One concern per PR.
- OS must never have an internal time gate.
- `BLOG_TEAMS_WEBHOOK_URL` must be distinct from `TEAMS_WEBHOOK_URL`.

---

## 2. Target Architecture

```
                       ┌───────────────────────────────┐
                       │  Hourly cron (UNCHANGED)      │
                       │  update-news → fetch-rss.js   │
                       │  → dist/news-data.json        │
                       └─────────────┬─────────────────┘
                                     │
                                     ▼ (read-only consumer)
┌────────────────────────────────────────────────────────────────┐
│                     DAILY BRIEF JOB (NEW)                       │
│                     cron: 0 10 * * *                            │
│                                                                 │
│  scripts/daily-brief.js                                         │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │  Stage A: Collect signal                                 │  │
│  │   ├─ Read dist/news-data.json (existing RSS aggregate)   │  │
│  │   ├─ scripts/fetchers/ntsb-carol.js  (NEW)               │  │
│  │   ├─ scripts/fetchers/sam-gov.js     (NEW)               │  │
│  │   ├─ scripts/fetchers/faa-safety.js  (NEW, RSS)          │  │
│  │   └─ scripts/fetchers/fsf.js         (NEW, RSS)          │  │
│  │                                                          │  │
│  │  Stage B: Pre-filter & dedupe (rule-based, no Claude)    │  │
│  │                                                          │  │
│  │  Stage C: Orchestrator context lookup                    │  │
│  │   └─ Query SharePoint for related past opportunities &   │  │
│  │      apps via Power Automate "lookup" flow               │  │
│  │                                                          │  │
│  │  Stage D: Single Claude call                             │  │
│  │   └─ Structured JSON output: tier + summary per item     │  │
│  │      (cap: 15/day, counter: dailyBriefCallsToday)        │  │
│  │                                                          │  │
│  │  Stage E: Write to SharePoint (via PA "ingest" flow)     │  │
│  │   └─ Every opportunity, every tier, including Archive    │  │
│  │                                                          │  │
│  │  Stage F: Build & post Adaptive Card                     │  │
│  │   ├─ Tiered sections (Act Now / Strong Lead / Watch /    │  │
│  │   │  Archive collapsed)                                  │  │
│  │   ├─ Action.OpenUrl buttons → 5 PA flows                 │  │
│  │   └─ Posted to BRIEF_TEAMS_WEBHOOK_URL (NEW secret)      │  │
│  └──────────────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────────────┘

Power Automate (existing infra, new flows):
  ├─ pai-brief-ingest          (write SP list rows)
  ├─ pai-brief-lookup          (read SP for orchestrator context)
  ├─ pai-action-bullets        (button: Bullet Points)
  ├─ pai-action-fulldraft      (button: Full Draft)
  ├─ pai-action-buildapp       (button: Build an App)
  ├─ pai-action-saveforlater   (button: Save for Later)
  └─ pai-action-pass           (button: Pass)

SharePoint (system of record):
  ├─ List: PAI Opportunities    (one row per surfaced opportunity)
  └─ List: PAI Apps Built       (one row per shipped app/blog post)
```

The hourly public pipeline does not change. The daily brief is the only new consumer; it reads `dist/news-data.json` exactly as `opportunity-spotter.js` does today.

---

## 3. Component-by-Component Design

### 3.1 Consolidated Daily Brief

**What it does**

Replaces the current two internal jobs (`opportunity-spotter`, `analyst-digest`) with a single daily script that produces one Adaptive Card with all candidate opportunities tiered into:

- **🔴 Act Now** — Time-sensitive, high-fit, deadline within 7 days (e.g., NPRM comment closes Friday; SAM.gov solicitation closes next week).
- **🟡 Strong Lead** — High-fit but not urgent. Worth a blog post or app this month.
- **🔵 Watch This** — Plausible but needs more signal. Re-evaluate if it appears again or escalates.
- **⚪ Archive** — Logged for the orchestrator's historical memory but collapsed/hidden in the card body.

**Audience tension — needs your decision**

Your three current outputs go to three different audiences:

| Output | Channel (env var) | Audience |
|---|---|---|
| Public daily digest | `TEAMS_WEBHOOK_URL` | Brand-facing — what's happening in aviation today |
| Analyst weekly | `ANALYST_TEAMS_WEBHOOK_URL` | PAI safety analysts — what to investigate |
| Opportunity Spotter daily | `BLOG_TEAMS_WEBHOOK_URL` | Content/product strategy — what to build/write |

A single card collapses safety-analyst signal and content-strategy signal into one feed. That's defensible — they're both internal, both decision-prompting. But the **public** daily digest is brand voice for a different audience (potentially clients or general PAI staff).

My recommendation: **Phase 1 protects the public daily digest.** The new consolidated brief replaces only the two internal cards (analyst + OS). The public hourly pipeline and its 10:00 UTC daily Teams digest stay 100% untouched.

If you want the public digest gone too, we do that in a much later phase after the unified brief has proven itself for several weeks.

**What needs to be built**

- New file: `scripts/daily-brief.js` (~600-800 lines, modeled after `opportunity-spotter.js`).
- New folder: `scripts/fetchers/` for the four data source modules (see §3.2).
- New folder: `scripts/lib/` for shared helpers (`sharepoint.js`, `tiering.js`, `card-builder.js`).
- New file: `daily-brief-config.json` (separate from `sources.json` to keep public pipeline clean).
- New cron + new job in `update-news.yml` (does NOT replace existing jobs in Phase 1).

**Claude prompt strategy**

Single batched call, structured JSON response, no per-item loop:

```
System: You are a content strategist for PAI Consulting, an aviation SMS
        and safety consulting firm. Tier each item below into one of:
        ACT_NOW, STRONG_LEAD, WATCH, ARCHIVE. Return JSON only.

User:   <bundled list of all candidate items from all sources, plus
         context block from orchestrator showing related past opportunities>

Output: { "items": [ { "id": "...", "tier": "ACT_NOW",
                       "summary": "...", "why_now": "...",
                       "related_to": ["past_opp_id_1", ...] } ] }
```

One call. Counter: `dailyBriefCallsToday`. Cap: 15/day (gives headroom for retries and a future second-pass call).

**Changes to existing files**

| File | Change | Risk |
|---|---|---|
| `.github/workflows/update-news.yml` | Add new `daily-brief` job with `if:` guard. **Do not touch the existing `update-news`, `analyst-digest`, or `opportunity-spotter` jobs in Phase 1.** | Low if additive |
| `CLAUDE.md` | Add Daily Brief reliability rules section, mirroring the OS rules | None |
| `scripts/usage-limit.js` | Add `dailyBriefCallsToday` to the CLI status command (purely cosmetic) | None |
| `package.json` | No changes — uses built-in `fetch`, existing `fast-xml-parser` | None |

**Files NOT to touch in Phase 1**

`fetch-rss.js`, `template.html`, `sources.json`, `manual.json`, `pai-content-library.json`, `dist/*`, `analyst-mode.js`, `opportunity-spotter.js`. The last two are the eventual replacement targets but we leave them running side-by-side until the new system has proven itself.

**New secrets**

- `BRIEF_TEAMS_WEBHOOK_URL` — destination Teams channel for the consolidated brief.

**Risks**

- **Cost spike from new sources.** Stage B pre-filter must be aggressive enough that the single Claude call stays manageable. NTSB CAROL alone could return hundreds of records — must cap and date-filter.
- **Card length.** Adaptive Cards have a payload limit (~28KB on Teams). With Archive collapsed and tiers capped (e.g., max 5 per tier), we should stay safe but I'll model this in Phase 1 build.
- **Tier drift.** Claude's tiering will be inconsistent week-to-week. Need a few-shot examples in the prompt and a stable rubric.

---

### 3.2 Expanded Data Sources

Two are simple RSS additions, two are real APIs that need their own fetchers.

#### 3.2.a FAASafety.gov & Flight Safety Foundation (simple)

**What**
- FAASafety.gov publishes SPANS (Safety Program Airmen Notification System) and FAAST notices via RSS.
- FSF publishes AeroSafety World articles via RSS.

**What needs to be built**
- Two lightweight RSS fetchers in `scripts/fetchers/faa-safety.js` and `scripts/fetchers/fsf.js`. They consume the same `fast-xml-parser` infrastructure as `fetch-rss.js` but **are imported by `daily-brief.js` only** — they do NOT get added to `sources.json` and do NOT appear in the public ticker.

**Why not just add them to sources.json?**
Two reasons. First, that touches the frozen public pipeline. Second, FAASafety SPANS notices and FSF AeroSafety articles are signal for PAI's *internal* decision-making, not necessarily content the brand newsfeed should be promoting (e.g., a SPANS notice about a temporary FDC NOTAM isn't general aviation news, it's a hint to PAI that a regulatory shift is coming).

If you want them in the public ticker too, that's a separate Phase 6 PR that touches `sources.json` only.

**Risks**
- FAASafety RSS endpoints sometimes drop entries when authentication is required. Fetcher must tolerate empty returns.

#### 3.2.b NTSB CAROL (richer)

**What**
NTSB's Case Analysis and Reporting Online has a public REST API for accident dockets and investigation reports — far richer than the existing NTSB RSS feed in `sources.json` (which is just press releases). CAROL gives you preliminary reports, factual reports, probable cause findings, recommendations.

**What needs to be built**
- `scripts/fetchers/ntsb-carol.js`
- Pulls accidents in the last N days (configurable, default 7), filtered to GA/Part 91 by aircraft category.
- Returns normalized records: `{ id, eventDate, location, aircraftMake, aircraftModel, narrative, preliminaryFinding, probableCause, recommendations[] }`
- Caches responses in `data/ntsb-cache.json` (NEW directory, not under `dist/`) keyed by event ID to avoid re-fetching unchanged records.

**Why this matters for opportunities**
A repeated probable-cause pattern (e.g., three independent fuel-exhaustion accidents in a month) is a strong signal for a SMS Quick Takes blog post or a fuel-planning checklist app. The orchestrator can detect these patterns by querying SharePoint history.

**Dependencies**
- No new npm packages (uses native `fetch`).
- No new secrets — CAROL is public.

**Risks**
- CAROL API response shapes change occasionally. Fetcher must validate and silent-skip on schema mismatch.
- Volume: a 7-day query can return 30-60 records. Need filtering (Part 91 only? US only?) before they go into the Claude prompt or the SharePoint write.
- **Storing cached NTSB data in the repo is borderline.** I'd put `data/` in `.gitignore` and rely on regenerating each run, OR commit it to a separate `data` branch parallel to `gh-pages`. My recommendation: don't commit it. Each daily run starts fresh.

#### 3.2.c SAM.gov (richest)

**What**
SAM.gov has a public Opportunities API. With an API key (free), you can query active solicitations filtered by NAICS code and posted-since date.

**Recommended NAICS codes for PAI**
- `481` Air Transportation (parent)
- `481211` Nonscheduled Chartered Passenger Air Transportation
- `488190` Other Support Activities for Air Transportation
- `541330` Engineering Services
- `541614` Process, Physical Distribution, and Logistics Consulting
- `541618` Other Management Consulting Services
- `611512` Flight Training
- `336411` Aircraft Manufacturing

The fetcher should accept a configurable list, defaulting to the above.

**What needs to be built**
- `scripts/fetchers/sam-gov.js`
- New secret: `SAM_GOV_API_KEY`
- Returns normalized records: `{ noticeId, title, agency, naicsCode, postedDate, responseDeadline, type, description, url }`.
- Date-filtered to "posted in last 7 days" by default; deadline-filtered to "responds within 30 days" to keep volume manageable.

**Why this is the highest-value source**
A SAM.gov solicitation matching PAI's NAICS codes is a literal money opportunity, not just a content idea. These should consistently land in **Act Now** if the response deadline is close.

**Dependencies**
- New secret `SAM_GOV_API_KEY` (free signup at api.sam.gov).
- No new npm packages.

**Risks**
- **API key rate limits.** SAM.gov API is rate-limited. Cache and/or limit to one fetch per daily run.
- **PII / restricted content.** Some SAM.gov notices have controlled access. Fetcher should only consume public-only endpoints and skip restricted records.
- **NAICS specificity.** Too narrow → miss relevant work. Too broad → noise. The default list above is a starting point; needs tuning after a few weeks.
- **A real money source surfaced as "Act Now" is high-stakes.** If the brief misses a deadline-sensitive notice, that's a real cost. Phase 1 of SAM.gov integration should be "logged but not yet in Act Now tier" — observe accuracy for a week before promoting it to action-tier status.

---

### 3.3 SharePoint Integration

**What it does**
Every opportunity surfaced — across all four tiers, including Archive — gets written to a SharePoint list as the system of record. Status starts as `new` and is updated by the action button flows.

**Recommended architecture: Power Automate as the integration layer**

I strongly recommend you do **not** call Microsoft Graph directly from the GitHub Actions runner. Reasons:

1. Graph requires app registration, client secret rotation, certificate management, and tenant admin consent. That's a lot of new attack surface inside CI.
2. You already have Power Automate licensing and (per your action-button request) you're going to be writing PA flows anyway.
3. Power Automate handles SharePoint auth via the connector — no secrets in the runner beyond a single flow URL.

**Architecture**

```
daily-brief.js
    │
    ▼ HTTP POST (JSON payload)
Power Automate "pai-brief-ingest" flow
  (When HTTP request received trigger)
    │
    ▼
SharePoint connector → Create item in "PAI Opportunities" list
```

**SharePoint list schema: PAI Opportunities**

| Column | Type | Notes |
|---|---|---|
| Title | Single line of text | Headline of the opportunity |
| OpportunityId | Single line of text | Hash, used for dedupe & action callbacks |
| DateSurfaced | Date and time | When the brief surfaced this |
| Tier | Choice | Act Now / Strong Lead / Watch This / Archive |
| Source | Single line of text | Where it came from (RSS source name, SAM.gov, NTSB, etc.) |
| SourceUrl | Hyperlink | Original URL |
| Summary | Multiple lines of text | Claude's summary |
| WhyNow | Multiple lines of text | Claude's "why now" |
| Status | Choice | new / in-progress / published / passed |
| ChargeCode | Single line of text | Filled in by user later |
| AssignedTo | Person or Group | Filled in by user later |
| RelatedAppUrl | Hyperlink | Filled in when an app is built |
| RelatedBlogUrl | Hyperlink | Filled in when a blog is published |
| RelatedOpportunities | Multiple lines of text | Comma-separated OpportunityIds from orchestrator |
| ClaudeRawJson | Multiple lines of text | Raw JSON from the Claude call (debugging) |

**SharePoint list schema: PAI Apps Built** (orchestrator memory, see §3.5)

| Column | Type |
|---|---|
| Title | App name |
| AppUrl | Hyperlink |
| LaunchedDate | Date and time |
| RelatedOpportunityIds | Multiple lines of text |
| Keywords | Single line of text |
| Categories | Multiple lines of text |
| Notes | Multiple lines of text |

**What needs to be built**

- `scripts/lib/sharepoint.js` — wrapper around `fetch()` to POST to the PA ingest flow. Silent-skip if `SHAREPOINT_INGEST_FLOW_URL` is not set.
- The PA flow itself: "When HTTP request received → Create item" with the schema above. You build this in Power Automate UI, not in code.
- The SharePoint lists. You provision these manually in SharePoint UI.

**New secrets**
- `SHAREPOINT_INGEST_FLOW_URL` — the PA HTTP trigger URL for the ingest flow.

**Risks**

- **PA HTTP trigger URLs are long-lived bearer URLs.** Anyone with the URL can write to your SharePoint list. Treat as a secret. Rotate periodically.
- **PA flows can fail silently from CI's perspective.** The script gets a 202 Accepted but doesn't know if the SharePoint write succeeded. Build a "Run after failure" branch in the PA flow that posts to a dead-letter Teams channel so you can monitor.
- **SharePoint list throttling.** PA's SharePoint connector has per-minute limits. With ~30 items/day this is fine, but if you ever ramp the brief to multiple times per day, watch for throttling.
- **Schema drift.** When you add a column to the SharePoint list, the PA flow needs to be updated. Document this dependency in CLAUDE.md.

---

### 3.4 Action Buttons

**What they do**
Each opportunity in the Adaptive Card gets five buttons. Clicking a button hits a Power Automate HTTP trigger and the flow does the work.

| Button | Flow | What the flow does |
|---|---|---|
| **Bullet Points** | `pai-action-bullets` | Generates bullet-point talking notes for the opportunity (PA → Claude or PA → OneNote template) and emails or DMs them to you |
| **Full Draft** | `pai-action-fulldraft` | Generates a draft blog post in OneDrive Word doc; sets SharePoint Status = `in-progress` |
| **Build an App** | `pai-action-buildapp` | Creates a Planner task in your "Build Queue" board; sets Status = `in-progress` |
| **Save for Later** | `pai-action-saveforlater` | Sets Status = `in-progress`, no action; surfaces it again in the next brief if no further action in 14 days |
| **Pass** | `pai-action-pass` | Sets Status = `passed`; the orchestrator remembers this and won't re-surface similar items |

**The hard part: how Adaptive Card buttons reach Power Automate from a Teams incoming webhook**

This is the design decision that has the most uncertainty and I want to flag it clearly.

Microsoft Teams Adaptive Cards posted via **incoming webhook** have **limited action support**. Specifically:

- `Action.OpenUrl` — ✅ supported. Opens a URL in a new browser tab.
- `Action.Submit` — ❌ not supported in incoming-webhook cards. Requires a bot.
- `Action.Http` — ⚠ deprecated, inconsistent support.

**The realistic options:**

**Option A: Action.OpenUrl with PA flow URLs (recommended)**
Each button is `Action.OpenUrl` pointing to a Power Automate "When HTTP request received" trigger URL with the opportunity ID encoded in the query string:

```
https://prod-XX.westus.logic.azure.com:443/workflows/.../triggers/manual/paths/invoke?
  api-version=2016-06-01&
  sp=...&
  sv=...&
  sig=...&
  oppId=abc123&
  action=bullets
```

When you click, a browser tab opens, the flow runs, and you see the flow's response page. The downside is that the user briefly sees a URL in a tab; the upside is it works today, has no Teams app installation, and uses only incoming-webhook mechanics.

**Option B: Build a small Teams bot**
Use Bot Framework + Adaptive Card `Action.Submit`. Buttons become invisible POSTs from Teams to your bot endpoint, which then triggers PA flows. Cleaner UX but requires a hosted bot, app registration, Teams admin app deployment. Significant new infrastructure.

**Option C: Outgoing webhook in Teams**
Type `@PAIBrief bullets abc123` in chat. Crude but works.

**My recommendation: Option A for Phase 4.** It's compatible with everything you already have, requires zero new infrastructure beyond the PA flows you're already building, and works with the existing incoming webhook architecture. The brief tab opening on click is a minor UX cost, not a blocker.

**Important caveat:** Microsoft has changed Teams Connector / incoming-webhook behavior multiple times. I'd verify Action.OpenUrl still works in your specific tenant before committing — that's a 5-minute test we should do in Phase 0.

**What needs to be built**

- `scripts/lib/card-builder.js` — function that builds the Adaptive Card with tiered sections and 5 buttons per opportunity. Each button URL constructed by interpolating the opportunity ID into a per-action template URL stored in env vars.
- Five Power Automate flows (built in PA UI, not in code).
- Each flow: receive HTTP → look up the opportunity in SharePoint by `oppId` → do its action → update SharePoint Status → return a small HTML response page.

**New secrets (one per action)**
- `PA_ACTION_BULLETS_URL`
- `PA_ACTION_FULLDRAFT_URL`
- `PA_ACTION_BUILDAPP_URL`
- `PA_ACTION_SAVEFORLATER_URL`
- `PA_ACTION_PASS_URL`

(Or one consolidated `PA_ACTION_BASE_URL` with action type as a query param. The five-secret approach is more secure because rotating one doesn't invalidate the others.)

**Risks**

- **Card payload bloat.** Five buttons per opportunity × 20 opportunities = 100 buttons. The card payload can hit Teams' 28KB limit. Mitigation: only show buttons on Act Now and Strong Lead tiers; Watch and Archive get a single "Promote" button.
- **Power Automate flow URLs are bearer tokens.** Anyone with the URL can trigger the flow. If a brief is forwarded outside your team, those button URLs leak. Mitigation: each PA flow must validate the `oppId` exists in SharePoint and is in `new` status before acting.
- **Click tracking.** No click telemetry by default. The orchestrator's "what got acted on" memory depends on each flow updating the SharePoint Status field. If a flow fails, the opportunity sits as `new` forever and re-surfaces. Build a Status='stuck' state for flows that errored.

---

### 3.5 App & Content Orchestrator

**What it does**
Maintains memory across time. Two responsibilities:

1. **Forward connection (memory injection):** When the daily brief is being built, query SharePoint for past opportunities and shipped apps that share keywords/categories with today's candidates. Inject this context into the Claude prompt so the brief can say *"this is the third NTSB fuel-exhaustion finding this month — consider extending the [existing app](url)"*.

2. **Backward connection (closure tracking):** When an opportunity transitions from `new` → `published` or `in-progress`, the action button flow updates the SharePoint row with `RelatedAppUrl` or `RelatedBlogUrl`. The orchestrator now knows that opportunity led to a real artifact.

**Architecture**

This is **not** a separate cron job. The orchestrator is a **library** (`scripts/lib/orchestrator.js`) called by `daily-brief.js` during Stage C, plus a set of conventions enforced by the action button flows during their write-back.

```
daily-brief.js Stage C:
    │
    ▼
orchestrator.fetchRelatedHistory(candidateItems)
    │
    ▼ HTTP POST to Power Automate "pai-brief-lookup" flow
    │   payload: { keywords: [...], categories: [...], naicsCodes: [...] }
    │
    ▼
PA flow queries SharePoint:
    - PAI Opportunities WHERE Keywords match (last 90 days)
    - PAI Apps Built WHERE Keywords match (last 18 months)
    │
    ▼ Returns to script
{
  relatedOpportunities: [ { id, title, tier, status, dateSurfaced } ],
  relatedApps: [ { title, url, launchedDate } ]
}
    │
    ▼
Included as a context block in the Claude prompt for Stage D tiering
```

**What needs to be built**

- `scripts/lib/orchestrator.js` — query helper (~150 lines).
- Power Automate flow `pai-brief-lookup` — accepts a JSON query, returns matched SharePoint records.
- Conventions documented in CLAUDE.md: every action flow MUST update SharePoint Status, and the "Build an App" / "Full Draft" flows MUST update `RelatedAppUrl` / `RelatedBlogUrl` when the artifact is finalized.

**Pattern detection (Phase 5+)**

True pattern detection ("we've gotten 3 NTSB fuel-exhaustion findings this month") can be done two ways:

1. **In Power Automate**, by querying SharePoint with date+keyword filters and counting results. PA exposes this count to the script as part of the lookup response.
2. **Inside `daily-brief.js`**, by passing a longer historical window to Claude and letting Claude detect the pattern. More expensive (more tokens) but smarter.

I'd start with #1 (rule-based counts). Promote to #2 only if rule-based misses obvious patterns.

**Querying for the orchestrator outside the daily brief**

You also asked for the orchestrator to be "queryable" — meaning ad-hoc questions like "show me everything related to FAR Part 141". That's just a SharePoint list view with a filter, no script needed. SharePoint UI handles ad-hoc query for free.

If you want a Claude-powered conversational interface ("Claude, summarize all opportunities this quarter related to SMS"), that's a separate Phase 6 feature: a small CLI tool `scripts/orchestrator-query.js` that takes a natural-language query, fetches matching SharePoint rows, and asks Claude to summarize them. New counter: `orchestratorQueryCallsToday`. This is optional and well outside Phase 1-3 scope.

**Risks**

- **SharePoint as a real-time queryable store has limitations.** It's not a database. A list with thousands of opportunities will become slow to query without indexed columns. Index the columns the orchestrator filters on (Tier, Status, DateSurfaced, Keywords).
- **Keyword overlap is a weak similarity metric.** "Fuel" matches both "fuel exhaustion" and "fuel cell technology". Phase 5+ can use embeddings; Phase 1-3 should accept this is a fuzzy match and let Claude do final relatedness judgment.

---

## 4. Cross-Cutting Concerns

### 4.1 Cost Safety

| Job | New Claude calls/day | Counter | Cap |
|---|---|---|---|
| daily-brief (orchestrator lookup is non-Claude) | 1 (tiering call) + 1 (optional refinement) | `dailyBriefCallsToday` | 15 |
| analyst-mode (parallel-running in Phase 1) | up to 10 | `analystCallsToday` | 100 (existing) |
| opportunity-spotter (parallel-running in Phase 1) | 1 | `opportunityCallsToday` | 10 (existing) |
| fetch-rss (public, untouched) | up to ~36 | `claudeCallsToday` | 900 (existing) |

In Phase 1-3, both old and new run in parallel. That's a deliberate cost: ~12 extra Claude calls/day during the validation period. After Phase 5 cuts over, the old jobs are deleted and total spend goes down.

The single biggest cost risk is Stage A pre-filter being too lenient and dumping hundreds of NTSB/SAM records into the Claude prompt. Mitigation: hard cap the Stage B output at 50 items maximum before Claude sees it.

### 4.2 Secrets Inventory

| Existing | New (Phase 1-3) |
|---|---|
| `ANTHROPIC_API_KEY` | `BRIEF_TEAMS_WEBHOOK_URL` |
| `TEAMS_WEBHOOK_URL` | `SHAREPOINT_INGEST_FLOW_URL` |
| `SLACK_WEBHOOK_URL` | `SHAREPOINT_LOOKUP_FLOW_URL` |
| `ANALYST_TEAMS_WEBHOOK_URL` | `SAM_GOV_API_KEY` |
| `BLOG_TEAMS_WEBHOOK_URL` | `PA_ACTION_BULLETS_URL` |
| | `PA_ACTION_FULLDRAFT_URL` |
| | `PA_ACTION_BUILDAPP_URL` |
| | `PA_ACTION_SAVEFORLATER_URL` |
| | `PA_ACTION_PASS_URL` |

That's 9 new GitHub Actions secrets. All must follow the existing convention: missing secret = silent skip (`exit 0`), never fail the workflow.

### 4.3 Branching Discipline

Per CLAUDE.md: `main` is PR-only except `pai-content-library.json`. The new SharePoint state lives entirely outside the repo, so there's no temptation to push state changes to main.

The new `data/` directory (if NTSB caching is implemented) must be in `.gitignore`.

The new `daily-brief-config.json` is a config file, not state, and lives on `main` like `sources.json`.

### 4.4 Workflow File Discipline

CLAUDE.md says "no workflow changes inside feature PRs". This conflicts with adding a new job. The interpretation I'm using: workflow changes are allowed in PRs whose **purpose** is the workflow change. So Phase 1's PR is explicitly a "wire up the daily-brief job" PR and that's its sole concern.

### 4.5 Observability

Currently you have no telemetry beyond GitHub Actions logs. With three new components writing to SharePoint, you need basic visibility:

- **Daily brief health card.** A second small Adaptive Card posted to the same channel after the main brief, showing "today's brief: 47 candidates, 3 Act Now, 8 Strong Lead, 12 Watch, 24 Archive — Claude calls used: 1/15 — SharePoint write: ✅".
- **Dead-letter channel.** A separate Teams channel `pai-brief-errors` that receives all error messages from PA flows and the script's `console.warn` paths via a `BRIEF_DLQ_WEBHOOK_URL` secret. This is the only place you'll find out something is broken before users notice.

---

## 5. Risk Register

| # | Risk | Severity | Mitigation |
|---|---|---|---|
| 1 | New job changes break public pipeline | 🔴 Critical | Phase 1 forbids any edits to `fetch-rss.js`, `template.html`, `sources.json` |
| 2 | Hourly cron + new daily cron at 10:00 UTC create overlap (we just fixed this for OS) | 🔴 Critical | New `daily-brief` job must use the same `if:` guard pattern (`schedule == '0 10 * * *'`) AND the script must NOT have its own internal hour gate (per CLAUDE.md OS rules) |
| 3 | Claude cost spike from over-permissive Stage B filter | 🟠 High | Hard cap at 50 items pre-Claude; observe `dailyBriefCallsToday` for first week |
| 4 | SAM.gov API key rate limit blocks brief | 🟠 High | Cache responses, single fetch per run, silent-skip on 429 |
| 5 | SharePoint list throttling | 🟡 Medium | Volume is low; revisit if frequency increases |
| 6 | PA flow URLs leak via brief forwarding | 🟠 High | Each flow validates `oppId` against SharePoint before acting |
| 7 | Action.OpenUrl unsupported in your Teams tenant | 🟠 High | Validate in Phase 0 before building anything |
| 8 | Card payload exceeds 28KB Teams limit | 🟡 Medium | Tier caps + collapsed Archive + buttons only on top tiers |
| 9 | Replacing analyst breaks the weekly safety review cadence | 🟡 Medium | Daily brief includes safety items every day; analyst-mode runs in parallel through Phase 4 |
| 10 | NTSB CAROL schema change breaks fetcher | 🟡 Medium | Schema validation + silent-skip + dead-letter alert |
| 11 | `analyst-mode.js` still has its internal hour gate (line 343) | 🟡 Medium | Either fix it as a separate small PR before this work, or accept it dies when analyst-mode is decommissioned in Phase 5 |
| 12 | Counter file in `dist/usage-counters.json` is shared across jobs and committed to gh-pages, creating git race conditions if jobs run concurrently | 🟡 Medium | Already a latent risk; new job uses its own counter key, so no new collision. Worth a future cleanup. |
| 13 | The brief becomes an SLA — clients/team rely on it daily and a missed run is noticed | 🟢 Low (today) → 🟠 High (after a month) | Build the dead-letter channel from day one |
| 14 | "All opportunities surfaced" surfaces noise that erodes trust | 🟠 High | Aggressive Stage B pre-filter; Archive tier collapsed by default; tunable rubric in `daily-brief-config.json` |

---

## 6. Phased Build Plan

### Phase 0 — Validation (no code, ~1 day)

**Goal:** Eliminate the unknowns before committing to architecture.

1. Verify Action.OpenUrl works in Adaptive Cards posted via incoming webhook in your Teams tenant. (Send yourself a test card with one button.)
2. Provision the two SharePoint lists with the schemas in §3.3.
3. Create one trial Power Automate flow ("When HTTP request received → Create item in PAI Opportunities → return 200") and POST to it from your laptop with `curl` to confirm SharePoint writes work end-to-end.
4. Get a free SAM.gov API key.
5. Confirm NTSB CAROL API endpoint is still live and returns data for a sample query.
6. Decide the public-digest question: keep it (recommended) or fold it into the consolidated brief later.

**Deliverable:** A short Markdown file (`docs/phase-0-findings.md`, kept on a branch — this is the only doc work that should be allowed in feature PRs) recording the answers. This becomes the source of truth for Phase 1's design decisions.

### Phase 1 — Skeleton, no behavior change (~1 PR)

**Goal:** Add the new daily-brief job and a no-op `daily-brief.js` that loads `news-data.json`, prints a summary, and exits 0. Nothing in the public pipeline changes. Nothing in analyst-mode or OS changes. The new job does NOT post to Teams.

**Files added**
- `scripts/daily-brief.js` (skeleton: load news-data.json, log, exit)
- `daily-brief-config.json` (empty defaults)
- `scripts/lib/orchestrator.js` (stub)
- `scripts/lib/sharepoint.js` (stub)
- `scripts/lib/card-builder.js` (stub)

**Files changed**
- `.github/workflows/update-news.yml` — add `daily-brief` job with `if:` guard. **Cron is `0 10 * * *` — same cron as opportunity-spotter, which is fine because they're separate jobs each gated by `if:`.** If you'd rather avoid any 10:00 UTC overlap, use `0 11 * * *` for daily-brief and update §2 accordingly.

**CLAUDE.md addition**
- New section "Daily Brief — Reliability Rules" mirroring the OS rules.

**Acceptance**
- Existing daily digest still fires once at 10:00 UTC.
- analyst-mode and opportunity-spotter still post normally.
- New `daily-brief` job runs daily, logs successfully, exits 0, posts nothing.
- No Claude calls made.

### Phase 2 — Data sources (~1 PR)

**Goal:** Wire up all four new fetchers to `daily-brief.js`. Still no Claude, still no Teams post, still no SharePoint write. The brief logs Stage A + Stage B output.

**Files added**
- `scripts/fetchers/faa-safety.js`
- `scripts/fetchers/fsf.js`
- `scripts/fetchers/ntsb-carol.js`
- `scripts/fetchers/sam-gov.js`

**Files changed**
- `daily-brief-config.json` — fetcher configuration (NAICS codes, keyword filters, date windows)
- `daily-brief.js` — call all four fetchers, dedupe with news-data.json, log Stage A + Stage B counts

**New secret**
- `SAM_GOV_API_KEY`

**Acceptance**
- Daily brief runs; logs show: "Stage A: 47 RSS + 12 NTSB + 6 SAM.gov + 8 FAA-Safety + 4 FSF = 77 items"
- "Stage B: filtered to 23 candidates"
- Still posts nothing.

### Phase 3 — Single Claude tiering call + Teams card (~1 PR)

**Goal:** First end-to-end output. Add the Stage D Claude call, build the Adaptive Card with tiered sections (no buttons yet), post to a NEW Teams test channel.

**Files changed**
- `scripts/daily-brief.js` — Stages D and F
- `scripts/lib/card-builder.js` — implements tiered card layout

**New secret**
- `BRIEF_TEAMS_WEBHOOK_URL` (point at a test channel for Phase 3, swap to production channel in Phase 5)

**Acceptance**
- One card per day in test channel.
- All four tiers visible.
- `dailyBriefCallsToday` ≤ 2.
- Visual review for one week before promoting to production channel.

### Phase 4 — SharePoint write + action buttons + orchestrator lookup (~1 PR, large)

**Goal:** Make every opportunity persist to SharePoint and every card actionable.

**Files changed**
- `scripts/daily-brief.js` — Stages C and E
- `scripts/lib/sharepoint.js` — implements PA flow POST
- `scripts/lib/orchestrator.js` — implements lookup
- `scripts/lib/card-builder.js` — adds 5 action buttons per opportunity (top tiers only)

**Power Automate work (outside the repo)**
- Build `pai-brief-ingest` flow
- Build `pai-brief-lookup` flow
- Build the 5 action flows

**New secrets**
- `SHAREPOINT_INGEST_FLOW_URL`
- `SHAREPOINT_LOOKUP_FLOW_URL`
- 5 × `PA_ACTION_*_URL`

**Acceptance**
- Every brief opportunity appears in the SharePoint list within 60 seconds of post.
- Clicking each button reaches its flow and updates the SharePoint Status correctly.
- Orchestrator lookup adds related-history context to at least 50% of items in the prompt.

### Phase 5 — Cutover (~1 PR)

**Goal:** Decommission `analyst-mode.js` and `opportunity-spotter.js` after a few weeks of parallel running.

**Files changed**
- `.github/workflows/update-news.yml` — remove `analyst-digest` and `opportunity-spotter` jobs
- `scripts/analyst-mode.js` — delete
- `scripts/opportunity-spotter.js` — delete
- `sources.json` — remove the `modes.analyst` block
- `scripts/usage-limit.js` — remove analyst and opportunity counter references
- `CLAUDE.md` — remove OS Reliability Rules section (or keep as historical), update Roadmap

**Acceptance**
- Old jobs gone, no broken references, public pipeline still works.
- One week of clean runs after cutover.

### Phase 6+ — Optional refinements

- Conversational orchestrator query CLI (`scripts/orchestrator-query.js`)
- Embeddings-based similarity for orchestrator
- FAASafety / FSF promotion to public ticker
- Public daily digest consolidation (only if you decided in Phase 0 that you want this)
- Trend-detection second Claude pass

---

## 7. Open Questions for You

Things I could not decide and need your input on before Phase 1:

1. **Public daily digest fate.** Keep untouched (recommended) or eventually retire and broadcast the new brief to the public channel? If keeping, no decision needed in Phase 1.
2. **`analyst-mode.js` internal hour gate (line 343).** This is the same anti-pattern we just removed from OS. Three options:
   - (a) Leave it alone — it dies in Phase 5 cutover.
   - (b) Fix it as a small standalone PR before this whole project starts.
   - (c) Document it as known-broken in CLAUDE.md and accept silent skips meanwhile.
3. **Cron timing for `daily-brief`.** Same `0 10 * * *` as OS (separate job, both gated by `if:`) or stagger to `0 11 * * *` for clarity? I'd recommend stagger because it makes log reading easier.
4. **Test channel vs. production channel in Phase 3.** Do you want to provision a brand new Teams channel `pai-brief-test` for Phase 3 validation, or post to your personal DM? I recommend a dedicated test channel that you can later rename to `pai-brief` for production cutover.
5. **NTSB caching policy.** No cache (re-fetch every run, simple but slower) or `data/` cache committed to a separate branch (faster, more complexity)? Recommend no cache in Phase 2; promote later if API rate limits become a problem.
6. **SAM.gov NAICS list.** Use my recommended default in §3.2.c or do you have a refined list? This needs your domain knowledge.
7. **Action button scope.** Should "Build an App" create a Planner task, an Azure DevOps work item, a GitHub Issue in a planning repo, or something else? The PA flow design depends on this.
8. **Orchestrator's "related opportunities" lookback window.** I proposed 90 days for opportunities and 18 months for apps. Does that feel right?

---

## 8. What This Plan Deliberately Does Not Include

To keep scope honest, I'm explicitly not proposing:

- A web dashboard for browsing opportunities (SharePoint UI is the dashboard).
- Automated PR creation when "Build an App" is clicked (that's a flow you can add later if useful).
- Email digest delivery (Teams card is the canonical channel).
- Multi-user assignment workflows (PA + SharePoint handle this natively).
- Replacing the public ticker with anything new.
- Migration off GitHub Pages or off the gh-pages branch.
- Anything that touches `template.html` or how articles render in Squarespace.
- Real-time websocket / push updates. The system stays daily-batch.

---

That's the plan. The shape I'd recommend most strongly is: **Phase 0 is non-optional**, **Phase 1 is risk-free**, and **Phases 2-4 each ship one observable improvement** so you can stop or change course at any phase boundary without strand-leaving.

Want me to deepen any section, or shall we start drawing up the actual Phase 1 PR?
