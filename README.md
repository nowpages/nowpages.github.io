# NowPages

> What are you doing *now*?

A free "now page" generator inspired by [Derek Sivers' /now movement](https://sive.rs/now). Fill out a simple form, pick a theme, and get a beautiful page hosted forever — no sign-up, no accounts, no cost.

**Live:** [nowpages.github.io](https://nowpages.github.io)

---

## What's a Now Page?

A now page is like an "about" page, but for what you're focused on *right now* — your current projects, interests, and priorities. Hundreds of people have one (see [nownownow.com](https://nownownow.com)), but most require setting up hosting and writing HTML yourself.

NowPages removes all of that. You fill out a form, hit publish, and your page is live.

## Features

**5 handcrafted themes** — Ink, Paper, Terminal, Dusk, and Sunlight, each with distinctive typography and personality.

**Instant publishing** — your page is live in seconds, no waiting for deploys.

**Full SEO** — every page ships with JSON-LD schema, Open Graph tags, Twitter Cards, and a dynamic social preview image. Share your link anywhere and it looks great.

**No accounts** — you get an edit token when you publish. Save it, and you can update your page anytime.

**Zero cost** — the entire stack runs on GitHub Pages and Cloudflare Workers free tiers. No databases, no servers.

**Zero JavaScript on generated pages** — your now page is pure HTML and CSS. It loads fast everywhere.

## Quick Start

1. Go to [nowpages.github.io](https://nowpages.github.io)
2. Pick a handle (this becomes your URL)
3. Fill in your name, tagline, and what you're focused on
4. Choose a theme
5. Hit **Publish**
6. Save your edit token — it's how you update your page later

Your page lives at `nowpages.github.io/your-handle`.

## Self-Hosting

Want to run your own instance? The setup takes about 10 minutes. You'll need a GitHub account and a free Cloudflare account.

See the [Architecture Guide](ARCHITECTURE.md) for how the system works, and the [Maintenance Guide](MAINTENANCE.md) for setup steps, PAT rotation, troubleshooting, and ongoing upkeep.

### Repo Structure

```
├── index.html        Landing page + editor
├── worker.js         Cloudflare Worker (publish, edit, serve)
├── og-worker.js      Cloudflare Worker (dynamic OG images)
├── wrangler.toml     Cloudflare config
├── manifest.json     Auto-generated directory of all pages
└── {handle}/
    └── index.html    Each user's generated now page
```

## Themes

| Theme | Vibe | Fonts |
|-------|------|-------|
| **Ink** | Dark, monospace, hacker | JetBrains Mono |
| **Paper** | Warm, editorial, literary | Source Serif 4 + Lora |
| **Terminal** | Retro CRT, green-on-black | JetBrains Mono |
| **Dusk** | Dark navy/purple, modern | IBM Plex Sans + Space Grotesk |
| **Sunlight** | Clean, bright, friendly | Inter + Space Grotesk |

## Documentation

- **[ARCHITECTURE.md](ARCHITECTURE.md)** — system design, request flows, data model, security model
- **[MAINTENANCE.md](MAINTENANCE.md)** — setup, PAT rotation, troubleshooting, adding themes, handling abuse

## License

MIT
