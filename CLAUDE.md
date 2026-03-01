# PAI AeroNews - Project Documentation

## Project Vision

PAI AeroNews is an automated aviation news aggregator for **Performance Aircraft, Inc.** that:
- Fetches aviation industry news from RSS feeds (free, unlimited)
- Updates automatically every hour via GitHub Actions
- Displays 24-48 articles in a scrolling ticker with PAI branding
- Generates AI-powered "takeaways" via Google Gemini (free tier)
- Features playback controls (pause, speed) and click-to-expand modal
- Embeds seamlessly in Squarespace via iframe
- Provides proper source attribution with category badges
- Supports manual article entry for breaking news/announcements

**Target Audience**: Aviation professionals, aircraft owners, industry stakeholders

---

## Architecture Overview

```
sources.json (RSS feed config) + manual.json (manual entries)
         ↓
GitHub Action (runs every hour)
         ↓
Node.js script (fetch-rss.js)
         ↓
Google Gemini API for AI takeaways (free tier)
         ↓
dist/index.html + dist/news-data.json
         ↓
GitHub Pages serves the files
         ↓
Squarespace iframe embeds the page
```

### Project Structure
```
pai-aeronews/
├── .github/
│   └── workflows/
│       └── update-news.yml    # Scheduled GitHub Action (hourly)
├── scripts/
│   └── fetch-rss.js           # RSS fetching + AI takeaways script
├── src/
│   └── template.html          # HTML template with styling + controls
├── dist/
│   ├── index.html             # Generated output (deployed)
│   └── news-data.json         # Structured data for Phase 2 features
├── sources.json               # RSS feed configuration
├── manual.json                # Manual article entries
├── CLAUDE.md                  # This documentation
├── package.json               # Node.js dependencies
└── .env.example               # Environment variables template
```

---

## Design System

### Colors
- **PAI Blue**: `#002F69` - Primary brand color, backgrounds
- **PAI Blue Dark**: `#001a3d` - Gradient end
- **Cyan Accent**: `#22D3EE` - Active states, highlights
- **White**: `#FFFFFF` - Card backgrounds, text on blue
- **Gray**: `#6B7280` - Secondary text

### Category Colors
| Category | Color | Hex |
|----------|-------|-----|
| General Aviation | Green | `#10B981` |
| Commercial | Blue | `#3B82F6` |
| Business Aviation | Purple | `#8B5CF6` |
| Industry | Amber | `#F59E0B` |
| Aerospace | Pink | `#EC4899` |
| eVTOL | Cyan | `#06B6D4` |
| Drones | Lime | `#84CC16` |
| Electric | Cyan | `#22D3EE` |
| Regulatory | Red | `#EF4444` |
| Safety | Red Dark | `#DC2626` |
| Military | Gray | `#6B7280` |
| Corporate | Violet | `#A855F7` |
| International | Teal | `#14B8A6` |

### Card Design
- Width: 300px (260px mobile)
- Border radius: 16px
- Shadow: `0 4px 12px rgba(0, 0, 0, 0.08)`
- Hover: lift effect + cyan border
- Click: opens modal with full article

### Animation
- Scrolling speed: Configurable (slow/normal/fast)
- Direction: Left to right (continuous loop)
- Pause on hover: Yes
- Keyboard shortcuts: Space (pause), arrows (speed)

---

## Data Structure

### News Article Schema
```javascript
{
  id: "abc123",                  // Generated hash
  headline: "Article Title",     // Cleaned headline
  blurb: "Description...",       // 1-2 sentences, max 300 chars
  source: {
    name: "AVweb",               // Human-readable source name
    url: "https://..."           // Link to original article
  },
  category: "general-aviation",  // Category tag
  keywords: ["Cessna", "safety"], // Extracted keywords
  publishedAt: "2025-02-18T10:30:00Z",
  takeaway: "AI insight..."      // AI-generated summary
}
```

### news-data.json Output
```json
{
  "lastUpdated": "2025-02-18T12:00:00Z",
  "articles": [...]
}
```

---

## RSS Feed Configuration

### sources.json Structure
```json
{
  "feeds": [
    {
      "name": "Source Name",
      "url": "https://example.com/feed/",
      "category": "general-aviation",
      "enabled": true
    }
  ],
  "settings": {
    "maxArticlesInTicker": 36,
    "archivePolicy": "keep-forever",
    "articlesPerFeed": 5
  }
}
```

### Adding New RSS Feeds
Edit `sources.json` and add:
```json
{
  "name": "New Source",
  "url": "https://newsource.com/feed/",
  "category": "commercial",
  "enabled": true
}
```
Push to main branch → automatic rebuild.

### Available Categories
- `general-aviation` - GA, flight training, private pilots
- `commercial` - Airlines, airports, passengers
- `aerospace` - Space, NASA, rockets
- `business-aviation` - Business jets, charter, FBOs
- `military` - Defense, military aircraft
- `safety` - NTSB, accidents, investigations
- `regulatory` - FAA, EASA, policy changes
- `corporate` - Manufacturer news (Boeing, Airbus)
- `industry` - Market analysis, trends
- `evtol` - Electric VTOL, air taxis
- `drones` - UAVs, unmanned cargo
- `electric` - Electric aircraft, hybrid propulsion
- `international` - Non-US aviation news

---

## Manual Article Entry

### manual.json Structure
```json
{
  "articles": [
    {
      "headline": "Your Headline Here",
      "blurb": "Brief description...",
      "source": "Performance Aircraft",
      "url": "https://performanceaircraft.com/...",
      "date": "2025-02-18",
      "category": "industry",
      "priority": "high",
      "takeaway": "Optional custom takeaway"
    }
  ]
}
```

- `priority: "high"` → appears first in ticker
- Manual articles override AI takeaway if provided
- Set `"articles": []` when no manual items needed

---

## Environment Variables

```bash
# Optional - for AI takeaways (highly recommended)
GOOGLE_AI_API_KEY=your_gemini_api_key_here
```

Get free Gemini API key: https://makersuite.google.com/app/apikey

**Without API key**: Falls back to rule-based takeaways based on keywords/category.

---

## GitHub Actions Workflow

### Schedule
- Runs every hour: `0 * * * *`
- Runs on push to main (sources.json, manual.json, scripts/*, src/*)
- Manual trigger available via `workflow_dispatch`

### Workflow Steps
1. Checkout repository
2. Setup Node.js 20
3. Install dependencies (`npm ci`)
4. Run fetch-rss.js script
5. Commit and push changes to dist/
6. Deploy to GitHub Pages

### Secrets Required
- `GOOGLE_AI_API_KEY` - (Optional but recommended) Google AI API key for Gemini

---

## User Interface Features

### Playback Controls
- **Pause/Play**: Toggle scrolling animation
- **Slow/Normal/Fast**: Adjust scroll speed
- **Keyboard**: Space (pause), ←/→ (speed)

### Click to Expand Modal
Click any card to open modal showing:
- Full headline
- Category badge with color
- Published date/time
- AI-generated takeaway
- Full description
- "See [Source] →" button (opens new tab)

Close with: X button, click outside, or Escape key

### Responsive Design
- Desktop: Full controls, keyboard hints
- Mobile: Stacked header, hidden keyboard hints
- Minimum width: 320px

---

## Squarespace Integration

### Iframe Embed Code
```html
<iframe
  src="https://YOUR_USERNAME.github.io/pai-aeronews/"
  width="100%"
  height="350"
  frameborder="0"
  scrolling="no"
  style="border: none; overflow: hidden;"
></iframe>
```

### Steps
1. Edit your page in Squarespace
2. Add a "Code" block (or Embed block)
3. Paste the iframe code
4. Replace `YOUR_USERNAME` with your GitHub username
5. Adjust height as needed (200-240px typical)
6. Save and publish

---

## AI Takeaways

### Google Gemini API
- **Model**: gemini-1.5-flash (fast, free tier)
- **Free Tier**: 60 requests/minute (plenty for ~36 articles/hour)
- **Cost**: $0/month within free tier

### Prompt
Generates one-sentence insights focusing on:
- Safety implications
- Operational impacts
- Business/industry trends
- Regulatory significance

### Fallback
If API unavailable, uses rule-based takeaways:
- Safety keywords → "Safety implications warrant industry attention."
- Boeing → "Boeing developments impact global aviation supply chain."
- FAA/EASA → "Regulatory changes may affect industry operations."
- etc.

---

## Development Commands

```bash
# Install dependencies
npm install

# Run locally (fetches RSS feeds, generates HTML + JSON)
npm run build

# Run with AI takeaways
GOOGLE_AI_API_KEY=xxx npm run build

# Preview the generated HTML
npm run preview
# Opens http://localhost:3000
```

---

## Troubleshooting

### News Not Updating
1. Check GitHub Actions tab for failed workflows
2. Verify RSS feeds are accessible (some may block automated requests)
3. Check workflow logs for error messages
4. Try manual trigger via `workflow_dispatch`

### RSS Feed Not Working
1. Test feed URL in browser
2. Check if feed requires authentication (won't work)
3. Disable feed in sources.json (`"enabled": false`)
4. Try alternative feed URL from same source

### AI Takeaways Not Generating
1. Verify `GOOGLE_AI_API_KEY` secret is set in GitHub
2. Check Gemini API quota in Google Cloud Console
3. Fallback takeaways will be used if API fails

### Iframe Not Displaying
1. Verify GitHub Pages is enabled (Settings → Pages)
2. Check direct URL: `https://USERNAME.github.io/pai-aeronews/`
3. Ensure Squarespace allows iframes from github.io

---

## Cost Summary

| Service | Cost |
|---------|------|
| GitHub Pages hosting | Free |
| GitHub Actions (hourly) | Free (public repo) |
| RSS feeds | Free |
| Google Gemini API (takeaways) | Free (60 req/min limit) |
| **Total** | **$0/month** |

---

## Roadmap

### Phase 1: Core Newsfeed (Current)
- [x] RSS feed aggregation (14+ sources)
- [x] GitHub Actions hourly updates
- [x] AI takeaways via Google Gemini
- [x] Modern UI with playback controls
- [x] Click-to-expand modal
- [x] Category badges and filtering foundation
- [x] Manual article entry support
- [x] news-data.json for Phase 2

### Phase 2: Delivery Channels (Future)
- [ ] Browser push notifications
- [ ] Email digest (daily/weekly)
- [ ] Teams/Slack webhooks
- [ ] Personalized topic alerts
- [ ] "Suggest a Source" form

### Phase 3+: Advanced Features (Long-term)
- [ ] AI trend analysis across articles
- [ ] Weekly AI summary newsletters
- [ ] Searchable archive UI
- [ ] International/translated content

---

## Contact & Support

**Project Owner**: Keith Pai, Performance Aircraft, Inc.
**Website**: https://www.performanceaircraft.com

---

## Changelog

### v2.0.0 (RSS Migration)
- Migrated from NewsAPI to RSS feeds (free, unlimited)
- Added 14+ RSS sources across multiple categories
- Implemented Google Gemini for AI takeaways (free tier)
- Added playback controls (pause/play, speed)
- Added click-to-expand modal with full details
- Added category badges with color coding
- Added manual article entry via manual.json
- Added news-data.json output for Phase 2
- Updated to hourly updates (was 4-hour)
- Modern card design with hover effects
- Keyboard shortcuts (Space, arrows)
- Responsive mobile layout

### v1.0.0 (Initial Release)
- Automated news fetching via NewsAPI
- GitHub Actions scheduled updates
- GitHub Pages deployment
- Squarespace iframe embedding
- PAI branded styling with scrolling animation

---

## Operating Rules

### A) Branching
- Never commit directly to `main`
- Use `phase-<N>-<short-name>` branches (e.g., `phase-2-analyst-mode`)
- Merge via pull requests only

### B) Stability
- Phase 1 public feed (`fetch-rss.js`, `template.html`, `dist/` output) is frozen unless explicitly stated
- New modes must not modify the public pipeline or its outputs

### C) Cost / Quota
- Pre-filter and deduplicate articles before any Gemini API call
- One Gemini call per article maximum
- Internal modes (analyst, etc.) run daily, not hourly — use schedule gates in scripts
- Monitor free-tier limits: 60 requests/minute for Gemini

### D) Secrets
- Never commit secrets or API keys
- Read from environment variables or GitHub Secrets only
- Missing secret = silent skip (exit 0), never fail the workflow

### E) Testing Checklist
Before merging any Phase 2+ change:
1. `npm run build` → `dist/index.html` and `dist/news-data.json` generate correctly
2. Public Teams/Slack digest is unaffected
3. New mode works end-to-end when secrets are present
4. New mode skips gracefully when secrets are missing (exit 0, no errors)

---

# Engineering Rules for PAI AeroNews

## Deployment Model
- main is PR-only
- gh-pages stores generated dist output
- CI must never push to main
- dist/ must never appear in feature PRs

## Gemini Cost Safety
- All Gemini calls must be guarded by canSpendGemini()
- recordGeminiCalls(1) must be called exactly once per HTTP attempt
- No double counting allowed
- No silent cost paths

## PR Hygiene
- One concern per PR
- No workflow changes inside feature PRs
- No generated artifacts in PRs
- Always review: gh pr diff <num> --name-only

## Conflict Resolution Rule
If conflict involves:
- dist/*
- .github/workflows/*
- generated output

Default resolution = take origin/main unless explicitly building infra.

## Keith Reminder System
When recommending merges or rebases:
- Always print exact git status before proceeding
- Always show diff list before merge
- Always confirm branch name
