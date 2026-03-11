# NowPages Architecture

> System design for a zero-cost, zero-auth "now page" generator.

---

## System Overview

NowPages lets anyone create a personal "now page" — a snapshot of what they're currently focused on — with no sign-up, no accounts, and no cost. The entire stack runs on free tiers.

```
User's browser
    │
    ├── GET nowpages.github.io          → GitHub Pages (static landing page + editor)
    ├── GET nowpages.github.io/{handle} → GitHub Pages (static generated page)
    │
    ├── POST /publish                   → Cloudflare Worker (nowpages-api)
    │       ├── Validates + sanitizes input
    │       ├── Generates HTML server-side
    │       ├── Pushes to GitHub via Contents API
    │       ├── Caches HTML in KV for instant serving
    │       └── Returns edit token (first publish only)
    │
    ├── GET /page/{handle}              → Cloudflare Worker (instant KV-cached page)
    │
    └── GET /og?name=...&theme=...      → Cloudflare Worker (nowpages-og, dynamic OG image)
```

## Infrastructure

### GitHub Pages (Static Hosting)

The repo `nowpages/nowpages.github.io` is a GitHub Pages site deployed from the `main` branch root. It serves:

- `index.html` — the landing page, editor, and directory
- `{handle}/index.html` — each user's generated now page
- `manifest.json` — auto-generated directory of all pages

GitHub Pages handles TLS, CDN caching, and global distribution at zero cost. The only caveat is a ~30-60 second deployment delay after new content is pushed.

### Cloudflare Workers (API Layer)

Two workers handle dynamic operations:

**nowpages-api** (`worker.js`) — the core API:

- `POST /publish` — create or update a page
- `POST /load` — load page data for editing (requires token)
- `GET /manifest` — return the directory of all pages
- `GET /page/:handle` — serve cached HTML instantly from KV

**nowpages-og** (`og-worker.js`) — dynamic OG image generation:

- `GET /og?name=...&tagline=...&theme=...&avatar=...` — returns a 1200x630 SVG image

### Cloudflare KV (Data Store)

A single KV namespace (`TOKENS`) stores all persistent data:

| Key Pattern | Value | Purpose |
|---|---|---|
| `page:{handle}` | JSON (metadata + hashed token) | Page ownership and edit verification |
| `html:{handle}` | Full HTML string | Instant page serving (bypasses GitHub Pages delay) |
| `manifest` | JSON array of all pages | Directory listing |
| `rl:{ip}` | Request count | Rate limiting (60s TTL) |

KV is eventually consistent with reads typically resolving in under 50ms globally.

## Request Flows

### First-Time Publish

```
1. User fills form on index.html
2. Browser sends POST /publish with structured data:
   { handle, displayName, tagline, avatarUrl, theme, focusItems, socials }
3. Worker validates all fields (length, format, allowed characters)
4. Worker checks rate limit (5 requests per IP per 60 seconds)
5. Worker checks handle availability (GET page:{handle} from KV)
6. Worker generates a 24-character edit token
7. Worker generates full HTML page server-side
8. Worker pushes {handle}/index.html to GitHub via Contents API
9. Worker stores page metadata + token hash in KV (page:{handle})
10. Worker caches full HTML in KV (html:{handle})
11. Worker updates manifest in KV and on GitHub
12. Worker returns success + edit token to browser
13. Browser shows:
    - Instant preview URL (worker-served from KV)
    - Permanent URL (GitHub Pages, available after ~1 min)
    - Edit token (user must save this)
```

### Edit Flow

```
1. User clicks "Edit your page" on landing page
2. Enters handle + edit token
3. Browser sends POST /load with { handle, editToken }
4. Worker retrieves page:{handle} from KV
5. Worker compares token using timing-safe comparison
6. If valid, returns stored page data (not HTML — structured fields)
7. Browser populates editor form with existing data
8. User makes changes, clicks Publish
9. Same as First-Time Publish steps 3-11, but:
   - Token is passed along (no new token generated)
   - GitHub API uses SHA of existing file for update (not create)
10. Worker returns success (no token in response for edits)
```

### Instant Page Serving

```
1. User visits /page/{handle} on the worker domain
2. Worker reads html:{handle} from KV
3. Returns cached HTML with Content-Type: text/html
4. Cache-Control: public, max-age=60
```

This serves pages instantly after publish, while GitHub Pages catches up (~30-60s).

## Security Model

### Server-Side HTML Generation

The client never sends raw HTML. It sends structured data (handle, name, tagline, focus items, etc.) and the worker generates the HTML. This eliminates XSS via user content entirely.

### Input Sanitization

All text inputs pass through `escapeHTML()` which converts `<`, `>`, `&`, `"`, and `'` to HTML entities. Additional sanitization:

- **Handle**: lowercase alphanumeric + hyphens only, 1-30 chars, validated via regex
- **Text fields**: stripped and length-limited (display name 100 chars, tagline 200 chars, focus items 500 chars each)
- **URLs**: must start with `https://` or `http://` (blocks `javascript:`, `data:`, and other dangerous schemes)
- **Theme**: validated against a whitelist of known theme names
- **Focus items**: max 10 items

### Edit Tokens

- 24 characters from a 31-character alphabet (lowercase + digits, excluding ambiguous chars like 0/o/l/1)
- ~10^35 possible combinations — brute force is infeasible
- Compared using constant-time comparison (`timingSafeEqual`) to prevent timing attacks
- Stored as-is in KV (not hashed, since they're random and high-entropy)
- Shown once on first publish — user must save it

### Rate Limiting

- 5 publish requests per IP address per 60-second window
- Tracked via KV keys `rl:{ip}` with 60-second TTL
- Returns 429 Too Many Requests when exceeded

### CORS

- `Access-Control-Allow-Origin` locked to the production domain (`https://nowpages.github.io`)
- No wildcard origins
- Preflight requests handled for POST methods

## Theme System

Five themes, each defined entirely in CSS custom properties:

| Theme | Background | Text | Accent | Font |
|---|---|---|---|---|
| Ink | #0a0a0a | #e0e0e0 | #00d4ff | JetBrains Mono |
| Paper | #faf8f5 | #2c2c2c | #c0392b | Source Serif 4 + Lora |
| Terminal | #0a0a0a | #00ff41 | #00ff41 | JetBrains Mono |
| Dusk | #0f0e17 | #fffffe | #ff8906 | IBM Plex Sans + Space Grotesk |
| Sunlight | #fffffe | #2b2c34 | #6246ea | Inter + Space Grotesk |

Themes are applied via `data-theme` attribute on `<html>`. CSS custom properties (`--bg`, `--text`, `--accent`, etc.) cascade to all elements. Zero JavaScript needed on generated pages.

## SEO Strategy

Every generated page includes:

- **Semantic HTML5**: `<article>`, `<header>`, `<section>`, `<footer>`
- **Title tag**: "{Name} — Now Page"
- **Meta description**: auto-generated from tagline
- **Canonical URL**: `https://nowpages.github.io/{handle}`
- **JSON-LD Person schema**: includes `name`, `url`, `description`, `knowsAbout` (from focus items)
- **Open Graph tags**: title, description, image, url, type=profile
- **Twitter Card tags**: summary_large_image format
- **Dynamic OG image**: generated per-page via the OG worker
- **Internal linking**: directory page links to all published pages
- **Footer attribution**: "Made with NowPages" backlink

## Data Model

### Page Metadata (KV: `page:{handle}`)

```json
{
  "handle": "vipin",
  "displayName": "Vipin",
  "tagline": "Building things on the internet",
  "avatarUrl": "https://example.com/photo.jpg",
  "theme": "ink",
  "focusItems": [
    { "emoji": "🚀", "title": "NowPages", "description": "A free now page generator" }
  ],
  "socials": {
    "twitter": "https://twitter.com/vipin",
    "github": "https://github.com/vipin"
  },
  "editToken": "abc123...",
  "createdAt": "2026-03-10T12:00:00Z",
  "updatedAt": "2026-03-10T12:00:00Z"
}
```

### Manifest (KV: `manifest`)

```json
[
  {
    "handle": "vipin",
    "displayName": "Vipin",
    "tagline": "Building things on the internet",
    "theme": "ink",
    "updatedAt": "2026-03-10T12:00:00Z"
  }
]
```

## Free Tier Limits

| Service | Limit | NowPages Usage |
|---|---|---|
| GitHub Pages | 100 GB bandwidth/month, 1 GB repo size | ~5KB per page = ~200,000 pages before repo limit |
| Cloudflare Workers | 100,000 requests/day | Each publish = ~3 requests (publish + manifest + GitHub API) |
| Cloudflare KV | 100,000 reads/day, 1,000 writes/day | Each publish = ~5 writes; reads scale with page views |
| GitHub API | 5,000 requests/hour (authenticated) | Each publish = 2-3 API calls |

The bottleneck is KV writes at 1,000/day — roughly 200 new pages or edits per day.
