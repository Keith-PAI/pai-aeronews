# PAI AeroNews

Automated aviation news aggregator for Performance Aircraft, Inc.

## Quick Start

### 1. Get a NewsAPI Key (Free)

1. Go to [newsapi.org/register](https://newsapi.org/register)
2. Sign up for a free account
3. Copy your API key

### 2. Set Up GitHub Repository

```bash
# Initialize git (if not already done)
cd pai-aeronews
git init

# Add all files
git add .
git commit -m "Initial PAI AeroNews setup"

# Create repo on GitHub, then:
git remote add origin https://github.com/YOUR_USERNAME/pai-aeronews.git
git branch -M main
git push -u origin main
```

### 3. Configure GitHub Secrets

1. Go to your repository on GitHub
2. Settings → Secrets and variables → Actions
3. Click "New repository secret"
4. Add secret named `NEWSAPI_KEY` with your API key

### 4. Enable GitHub Pages

1. Settings → Pages
2. Source: "GitHub Actions"
3. Save

### 5. Trigger First Update

Either:
- Push any change to trigger the workflow
- Go to Actions → "Update News" → "Run workflow"

### 6. Embed in Squarespace

```html
<iframe
  src="https://YOUR_USERNAME.github.io/pai-aeronews/"
  width="100%"
  height="200"
  frameborder="0"
  scrolling="no"
  style="border: none; overflow: hidden;"
></iframe>
```

## Local Development

```bash
# Install dependencies
npm install

# Run locally (requires NEWSAPI_KEY)
NEWSAPI_KEY=your_key_here npm run build

# Preview the output
npm run preview
# Opens at http://localhost:3000
```

## Optional: AI Takeaways

Add `ANTHROPIC_API_KEY` to GitHub secrets to enable AI-generated takeaways.

## Documentation

See [CLAUDE.md](./CLAUDE.md) for detailed documentation.
