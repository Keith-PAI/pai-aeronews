# PAI AeroNews

Automated aviation news aggregator for **PAI Consulting**. Fetches aviation industry news from RSS feeds, generates AI-powered takeaways via Google Gemini, and displays them in a scrolling ticker designed to embed in Squarespace.

## Features

- 12+ aviation RSS sources across multiple categories
- AI-generated takeaways via Google Gemini (free tier)
- Hourly automatic updates via GitHub Actions
- Scrolling ticker with playback controls (pause, speed)
- Click-to-expand modal with full article details
- Category badges with color coding
- Manual article entry for breaking news/announcements
- "Suggest a Source" form for community engagement
- Webhook notifications (Microsoft Teams & Slack)
- Responsive design for desktop and mobile
- Keyboard shortcuts (Space: pause, Arrows: speed)

## Quick Start

### 1. Install Dependencies

```bash
npm install
```

### 2. Configure GitHub Secrets

Go to your repository: **Settings → Secrets and variables → Actions**, then add:

| Secret | Required | Description |
|--------|----------|-------------|
| `GOOGLE_AI_API_KEY` | Recommended | Google Gemini API key for AI takeaways. [Get one free](https://makersuite.google.com/app/apikey) |
| `TEAMS_WEBHOOK_URL` | Optional | Microsoft Teams incoming webhook URL for notifications |
| `SLACK_WEBHOOK_URL` | Optional | Slack incoming webhook URL for notifications |

Without the Gemini API key, the system falls back to rule-based takeaways.

### 3. Enable GitHub Pages

1. Settings → Pages
2. Source: **GitHub Actions**
3. Save

### 4. Trigger First Update

Either:
- Push any change to trigger the workflow
- Go to **Actions → "Update Aviation News" → "Run workflow"**

### 5. Embed in Squarespace

```html
<iframe
  src="https://YOUR_USERNAME.github.io/pai-aeronews/"
  width="100%"
  height="220"
  frameborder="0"
  scrolling="no"
  style="border: none; overflow: hidden;"
></iframe>
```

## Local Development

```bash
# Run locally (fetches RSS feeds, generates HTML + JSON)
npm run build

# Run with AI takeaways
GOOGLE_AI_API_KEY=your_key npm run build

# Preview the generated HTML
npm run preview
# Opens at http://localhost:3000
```

## Configuration

### RSS Feeds

Edit `sources.json` to add, remove, or disable feeds:

```json
{
  "name": "Source Name",
  "url": "https://example.com/feed/",
  "category": "general-aviation",
  "enabled": true
}
```

### Manual Articles

Edit `manual.json` to add breaking news or announcements:

```json
{
  "articles": [
    {
      "headline": "Your Headline",
      "blurb": "Brief description...",
      "source": "PAI Consulting",
      "url": "https://paiconsulting.com/...",
      "date": "2026-02-19",
      "category": "industry",
      "priority": "high"
    }
  ]
}
```

### Webhook Notifications

Configure in the `webhooks` section of `sources.json`:

- **`mode`**: `"daily"` (one digest per day) or `"every"` (each hourly update)
- **`dailyDigestHourUTC`**: Hour to send daily digest (default: 11 = 6am ET)
- **`maxArticlesInDigest`**: Number of top headlines to include (default: 10)

## Cost

| Service | Cost |
|---------|------|
| GitHub Pages hosting | Free |
| GitHub Actions (hourly) | Free (public repo) |
| RSS feeds | Free |
| Google Gemini API | Free (60 req/min) |
| **Total** | **$0/month** |

## Documentation

See [CLAUDE.md](./CLAUDE.md) for detailed architecture, design system, and roadmap.
