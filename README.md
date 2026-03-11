# NowPages

> What are you doing now?

A free, beautiful "now page" generator inspired by [sive.rs/now](https://sive.rs/now). Users fill out a form, get a stunning static HTML page hosted for free on GitHub Pages.

**Live:** [nowpages.github.io](https://nowpages.github.io)

---

## Architecture

```
User → Landing page (index.html on GitHub Pages)
     → Fills out form
     → Clicks "Publish"
     → POST to Cloudflare Worker (nowpages-api)
     → Worker generates HTML + pushes to GitHub via API
     → Page live at nowpages.github.io/{handle}
     → Edit token emailed to user
```

### Repo structure

```
/
├── index.html          ← Landing page + editor (the product)
├── manifest.json       ← Auto-generated directory of all pages
├── worker.js           ← Cloudflare Worker: publish, edit, manifest
├── og-worker.js        ← Cloudflare Worker: dynamic OG images
├── wrangler.toml       ← Cloudflare config
├── vipin/
│   └── index.html      ← Example now page
└── {handle}/
    └── index.html      ← Each user's now page
```

## Setup Guide

### 1. GitHub Repo + Pages

1. Create a GitHub organization (e.g., `nowpages`)
2. Create a public repo named `nowpages.github.io`
3. Go to **Settings → Pages** → Source: **Deploy from branch** → Branch: `main`, folder: `/ (root)`
4. Push this code to the repo
5. Create a **Personal Access Token** (classic) with `repo` scope at [github.com/settings/tokens](https://github.com/settings/tokens)

### 2. Cloudflare Workers

1. Install Wrangler: `npm install -g wrangler`
2. Login: `wrangler login`
3. Create KV namespace:
   ```bash
   wrangler kv:namespace create TOKENS
   ```
4. Copy the namespace ID into `wrangler.toml`
5. Set secrets:
   ```bash
   wrangler secret put GITHUB_PAT
   wrangler secret put MAILGUN_API_KEY    # optional: for edit token emails
   wrangler secret put MAILGUN_DOMAIN     # optional
   ```
6. Deploy the API worker:
   ```bash
   wrangler deploy
   ```
7. Deploy the OG image worker:
   ```bash
   wrangler deploy og-worker.js --name nowpages-og
   ```

### 3. Update the landing page

In `index.html`, update the `WORKER_URL` constant to your deployed worker URL:
```javascript
const WORKER_URL = 'https://nowpages-api.{your-subdomain}.workers.dev';
```

### 4. Email setup (optional but recommended)

For sending edit tokens, set up [Mailgun](https://www.mailgun.com/) (free for 5k emails/month) or swap the email function in `worker.js` for Resend, SendGrid, or any transactional email service.

Without email configured, edit tokens are logged to the worker console (viewable in Cloudflare dashboard → Workers → Logs).

## Themes

Five built-in themes, each with distinctive typography:

| Theme | Vibe | Fonts |
|-------|------|-------|
| **Ink** | Dark, monospace, hacker | JetBrains Mono |
| **Paper** | Warm, editorial, literary | Source Serif 4 + Lora |
| **Terminal** | Retro CRT, green-on-black | JetBrains Mono |
| **Dusk** | Dark navy/purple, modern | IBM Plex Sans + Space Grotesk |
| **Sunlight** | Clean, bright, friendly | Inter + Space Grotesk |

## How editing works

1. User publishes → random edit token generated → emailed to them
2. To edit: click "Edit existing" → enter handle + token
3. Worker verifies token against Cloudflare KV
4. If valid, loads their page data into the editor
5. User makes changes, clicks "Publish" again (token passed along)
6. Worker updates the file on GitHub

No accounts. No passwords. No OAuth. Just a token in your inbox.

## SEO features

Every generated page includes:

- Semantic HTML5 (`<article>`, `<header>`, `<section>`, `<footer>`)
- `<title>` and `<meta description>` auto-generated
- Canonical URL
- JSON-LD `Person` schema with `knowsAbout`
- Open Graph tags (title, description, image, url, type=profile)
- Twitter Card tags (summary_large_image)
- Dynamic OG image via worker endpoint
- Zero JavaScript — pure HTML/CSS
- Internal linking via directory + "Made with NowPages" footer

## License

MIT — Built with care by an indie maker.
