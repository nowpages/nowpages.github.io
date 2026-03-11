/**
 * NowPages — Cloudflare Worker (Secured)
 *
 * SECURITY MODEL:
 * - HTML is generated SERVER-SIDE from structured data only (no raw HTML from clients)
 * - All user input is sanitized and length-capped
 * - Rate limiting per IP (10 publishes/hour, 30 loads/hour)
 * - Edit tokens are 24 chars from 31-char alphabet (31^24 ≈ 10^35 combinations)
 * - Timing-safe token comparison to prevent timing attacks
 * - CORS locked to production domain
 * - No email dependency — token shown on-screen at publish time
 *
 * Endpoints:
 *   POST /publish       — Create or update a now page
 *   POST /load          — Load existing page data for editing (requires handle + token)
 *   GET  /manifest      — Returns the directory listing
 *   GET  /page/:handle  — Instantly serves a page from KV (no GitHub Pages delay)
 *
 * Environment variables (Cloudflare dashboard → Settings → Variables):
 *   GITHUB_PAT    — GitHub PAT with repo write access
 *   GITHUB_OWNER  — GitHub org/user (e.g. "nowpages")
 *   GITHUB_REPO   — Repo name (e.g. "nowpages.github.io")
 *   ALLOWED_ORIGIN — Your domain (e.g. "https://nowpages.github.io")
 *
 * KV Namespace binding:
 *   TOKENS — Cloudflare KV namespace for edit tokens, page metadata, rate limits
 */

// ─── CONFIG ──────────────────────────────────────────────
const RATE_LIMIT = {
  publish: { max: 10, windowSec: 3600 },   // 10 publishes per IP per hour
  load:    { max: 30, windowSec: 3600 },    // 30 loads per IP per hour
};

const INPUT_LIMITS = {
  handle:      { min: 2, max: 40 },
  displayName: { max: 60 },
  tagline:     { max: 140 },
  avatarUrl:   { max: 500 },
  focusItem:   { max: 200 },
  focusCount:  { max: 7 },
  socialUrl:   { max: 200 },
};

const RESERVED_HANDLES = new Set([
  'admin', 'api', 'www', 'mail', 'blog', 'help', 'support', 'about',
  'create', 'edit', 'assets', 'static', 'js', 'css', 'img', 'fonts',
  'manifest', 'index', 'login', 'signup', 'settings', 'dashboard',
  'null', 'undefined', 'true', 'false', 'og', 'favicon',
]);

// ─── ENTRY ───────────────────────────────────────────────
export default {
  async fetch(request, env) {
    const origin = env.ALLOWED_ORIGIN || 'https://nowpages.github.io';

    const corsHeaders = {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Vary': 'Origin',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    const url = new URL(request.url);
    const clientIP = request.headers.get('CF-Connecting-IP') || 'unknown';

    try {
      if (url.pathname === '/publish' && request.method === 'POST') {
        return await handlePublish(request, env, corsHeaders, clientIP);
      }
      if (url.pathname === '/load' && request.method === 'POST') {
        return await handleLoad(request, env, corsHeaders, clientIP);
      }
      if (url.pathname === '/manifest' && request.method === 'GET') {
        return await handleManifest(env, corsHeaders);
      }
      // Instant page serving from KV — no GitHub Pages delay
      const pageMatch = url.pathname.match(/^\/page\/([a-z0-9\-]+)\/?$/);
      if (pageMatch && request.method === 'GET') {
        return await handleServePage(pageMatch[1], env);
      }
      return jsonResponse({ error: 'Not found' }, 404, corsHeaders);
    } catch (err) {
      console.error('Unhandled error:', err.message);
      return jsonResponse({ error: 'Internal server error' }, 500, corsHeaders);
    }
  }
};

// ─── PUBLISH ─────────────────────────────────────────────
async function handlePublish(request, env, corsHeaders, clientIP) {
  // Rate limit
  const rateCheck = await checkRateLimit(env, `rl:publish:${clientIP}`, RATE_LIMIT.publish);
  if (!rateCheck.ok) {
    return jsonResponse({ error: `Too many requests. Try again in ${rateCheck.retryAfter} minutes.` }, 429, corsHeaders);
  }

  const body = await request.json();

  // ── Sanitize & validate all inputs ──
  const handle = sanitizeHandle(body.handle);
  if (!handle || handle.length < INPUT_LIMITS.handle.min || handle.length > INPUT_LIMITS.handle.max) {
    return jsonResponse({ error: 'Handle must be 2-40 characters (lowercase letters, numbers, hyphens). No leading/trailing hyphens.' }, 400, corsHeaders);
  }
  if (RESERVED_HANDLES.has(handle)) {
    return jsonResponse({ error: 'This handle is reserved. Please choose another.' }, 400, corsHeaders);
  }

  const displayName = sanitizeText(body.displayName, INPUT_LIMITS.displayName.max);
  if (!displayName) {
    return jsonResponse({ error: 'Display name is required.' }, 400, corsHeaders);
  }

  const tagline = sanitizeText(body.tagline, INPUT_LIMITS.tagline.max);
  const avatarUrl = sanitizeUrl(body.avatarUrl, INPUT_LIMITS.avatarUrl.max);
  const theme = ['ink', 'paper', 'terminal', 'dusk', 'sunlight'].includes(body.theme) ? body.theme : 'ink';

  // Focus items
  const rawFocus = Array.isArray(body.focusItems) ? body.focusItems : [];
  const focusItems = rawFocus
    .map(item => sanitizeText(item, INPUT_LIMITS.focusItem.max))
    .filter(Boolean)
    .slice(0, INPUT_LIMITS.focusCount.max);

  if (focusItems.length === 0) {
    return jsonResponse({ error: 'Add at least one focus item.' }, 400, corsHeaders);
  }

  // Social links
  const socials = {
    github:   sanitizeUrl(body.socials?.github, INPUT_LIMITS.socialUrl.max),
    twitter:  sanitizeUrl(body.socials?.twitter, INPUT_LIMITS.socialUrl.max),
    linkedin: sanitizeUrl(body.socials?.linkedin, INPUT_LIMITS.socialUrl.max),
    website:  sanitizeUrl(body.socials?.website, INPUT_LIMITS.socialUrl.max),
  };

  // ── Check ownership ──
  const existing = await env.TOKENS.get(`page:${handle}`, 'json');

  if (existing) {
    const providedToken = typeof body.editToken === 'string' ? body.editToken.trim() : '';
    if (!providedToken || !timingSafeEqual(providedToken, existing.token)) {
      return jsonResponse({
        error: 'This handle is already taken. If it\'s yours, use "Edit existing" with your edit token.'
      }, 409, corsHeaders);
    }
  }

  // ── Generate edit token (new pages only) ──
  const editToken = existing ? existing.token : generateToken();

  // ── Generate HTML server-side (this is the security-critical part) ──
  const pageHTML = generatePageHTML({
    handle, displayName, tagline, avatarUrl, theme, focusItems, socials,
  });

  // ── Cache HTML in KV for instant serving ──
  await env.TOKENS.put(`html:${handle}`, pageHTML);

  // ── Push to GitHub (runs in background — may take 1-2 min to deploy) ──
  const githubResult = await pushToGitHub(env, handle, pageHTML);
  if (!githubResult.ok) {
    return jsonResponse({ error: 'Failed to publish. Please try again.' }, 502, corsHeaders);
  }

  // ── Store metadata in KV ──
  const pageData = {
    handle,
    displayName,
    tagline,
    avatarUrl,
    theme,
    focusItems,
    socials,
    token: editToken,
    createdAt: existing?.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  await env.TOKENS.put(`page:${handle}`, JSON.stringify(pageData));

  // ── Update manifest ──
  await updateManifest(env, pageData);

  // ── Return token to client (shown on-screen, no email needed) ──
  const response = {
    success: true,
    handle,
    url: `https://nowpages.github.io/${handle}`,
  };

  // Only include token for NEW pages (don't re-expose on edits)
  if (!existing) {
    response.editToken = editToken;
    response.isNew = true;
  } else {
    response.isNew = false;
  }

  return jsonResponse(response, 200, corsHeaders);
}

// ─── LOAD (for editing) ──────────────────────────────────
async function handleLoad(request, env, corsHeaders, clientIP) {
  // Rate limit
  const rateCheck = await checkRateLimit(env, `rl:load:${clientIP}`, RATE_LIMIT.load);
  if (!rateCheck.ok) {
    return jsonResponse({ error: `Too many attempts. Try again in ${rateCheck.retryAfter} minutes.` }, 429, corsHeaders);
  }

  const body = await request.json();
  const handle = sanitizeHandle(body.handle);
  const token = typeof body.token === 'string' ? body.token.trim() : '';

  if (!handle || !token) {
    return jsonResponse({ error: 'Handle and token are required.' }, 400, corsHeaders);
  }

  const existing = await env.TOKENS.get(`page:${handle}`, 'json');

  // Use timing-safe comparison & don't reveal whether handle exists
  if (!existing || !timingSafeEqual(token, existing.token)) {
    return jsonResponse({ error: 'Invalid handle or token.' }, 403, corsHeaders);
  }

  // Return page data (token is NOT included in response)
  return jsonResponse({
    data: {
      handle: existing.handle,
      displayName: existing.displayName,
      tagline: existing.tagline,
      avatarUrl: existing.avatarUrl,
      theme: existing.theme || 'ink',
      focusItems: existing.focusItems || [],
      socials: existing.socials || {},
    }
  }, 200, corsHeaders);
}

// ─── SERVE PAGE (instant, from KV) ───────────────────────
async function handleServePage(handle, env) {
  const html = await env.TOKENS.get(`html:${handle}`);
  if (!html) {
    return new Response('Page not found', { status: 404, headers: { 'Content-Type': 'text/plain' } });
  }
  return new Response(html, {
    status: 200,
    headers: {
      'Content-Type': 'text/html;charset=UTF-8',
      'Cache-Control': 'public, max-age=60',
    }
  });
}

// ─── MANIFEST ────────────────────────────────────────────
async function handleManifest(env, corsHeaders) {
  const manifest = await env.TOKENS.get('manifest', 'json');
  return jsonResponse(manifest || [], 200, {
    ...corsHeaders,
    'Cache-Control': 'public, max-age=60',
  });
}

// ═════════════════════════════════════════════════════════
//  SERVER-SIDE HTML GENERATION
//  All user input goes through escapeHTML() — no raw HTML
//  is ever accepted from the client.
// ═════════════════════════════════════════════════════════

function generatePageHTML({ handle, displayName, tagline, avatarUrl, theme, focusItems, socials }) {
  const name = escapeHTML(displayName);
  const tag = escapeHTML(tagline);
  const avatar = escapeHTML(avatarUrl || `https://api.dicebear.com/7.x/notionists/svg?seed=${handle}`);
  const url = `https://nowpages.github.io/${escapeHTML(handle)}`;
  const desc = escapeHTML(tagline + (focusItems.length ? ' — Currently focused on ' + focusItems[0] : ''));

  const today = new Date();
  const dateStr = today.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  const isoDate = today.toISOString().split('T')[0];
  const themeAttr = theme === 'ink' ? '' : ` data-theme="${theme}"`;

  // JSON-LD sameAs
  const sameAs = [socials.github, socials.twitter, socials.linkedin, socials.website]
    .filter(Boolean)
    .map(u => `"${escapeHTML(u)}"`);

  // Focus items HTML
  const focusHTML = focusItems
    .map(item => `      <li class="now-item">${escapeHTML(item)}</li>`)
    .join('\n');

  // knowsAbout for JSON-LD
  const knowsAbout = focusItems.map(item => `"${escapeHTML(item)}"`).join(', ');

  // Social links HTML
  let socialsHTML = '';
  if (socials.github) {
    socialsHTML += `      <a class="social-link" href="${escapeHTML(socials.github)}" rel="noopener noreferrer" target="_blank"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.477 2 2 6.477 2 12c0 4.42 2.865 8.166 6.839 9.489.5.092.682-.217.682-.482 0-.237-.009-.866-.013-1.7-2.782.604-3.369-1.34-3.369-1.34-.454-1.156-1.11-1.464-1.11-1.464-.908-.62.069-.608.069-.608 1.003.07 1.531 1.03 1.531 1.03.892 1.529 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.11-4.555-4.943 0-1.091.39-1.984 1.029-2.683-.103-.253-.446-1.27.098-2.647 0 0 .84-.269 2.75 1.025A9.578 9.578 0 0112 6.836c.85.004 1.705.115 2.504.337 1.909-1.294 2.747-1.025 2.747-1.025.546 1.377.203 2.394.1 2.647.64.699 1.028 1.592 1.028 2.683 0 3.842-2.339 4.687-4.566 4.935.359.309.678.919.678 1.852 0 1.336-.012 2.415-.012 2.743 0 .267.18.578.688.48C19.138 20.163 22 16.418 22 12c0-5.523-4.477-10-10-10z"/></svg>GitHub</a>\n`;
  }
  if (socials.twitter) {
    socialsHTML += `      <a class="social-link" href="${escapeHTML(socials.twitter)}" rel="noopener noreferrer" target="_blank"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>X / Twitter</a>\n`;
  }
  if (socials.linkedin) {
    socialsHTML += `      <a class="social-link" href="${escapeHTML(socials.linkedin)}" rel="noopener noreferrer" target="_blank"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433a2.062 2.062 0 01-2.063-2.065 2.064 2.064 0 112.063 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z"/></svg>LinkedIn</a>\n`;
  }
  if (socials.website) {
    socialsHTML += `      <a class="social-link" href="${escapeHTML(socials.website)}" rel="noopener noreferrer" target="_blank"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 014 10 15.3 15.3 0 01-4 10 15.3 15.3 0 01-4-10 15.3 15.3 0 014-10z"/></svg>Website</a>\n`;
  }

  const socialSection = socialsHTML ? `
  <hr class="divider" aria-hidden="true">

  <section aria-label="Social links">
    <p class="section-label">Find me</p>
    <nav class="socials">
${socialsHTML}    </nav>
  </section>` : '';

  return `<!DOCTYPE html>
<html lang="en"${themeAttr}>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${name} — Now Page</title>
<meta name="description" content="${desc}">
<link rel="canonical" href="${url}">

<meta property="og:type" content="profile">
<meta property="og:title" content="${name} — Now Page">
<meta property="og:description" content="${desc}">
<meta property="og:url" content="${url}">
<meta property="og:image" content="https://nowpages-og.workers.dev/og?name=${encodeURIComponent(displayName)}&tagline=${encodeURIComponent(tagline)}&theme=${theme}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:site_name" content="NowPages">
<meta property="profile:username" content="${escapeHTML(handle)}">

<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${name} — Now Page">
<meta name="twitter:description" content="${desc}">
<meta name="twitter:image" content="https://nowpages-og.workers.dev/og?name=${encodeURIComponent(displayName)}&tagline=${encodeURIComponent(tagline)}&theme=${theme}">

<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "Person",
  "name": "${name}",
  "description": "${tag}",
  "url": "${url}",
  "sameAs": [${sameAs.join(', ')}],
  "image": "${avatar}",
  "knowsAbout": [${knowsAbout}]
}
</script>

<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;700&family=Inter:wght@400;500;600&family=Lora:ital,wght@0,400;0,600;1,400&family=Space+Grotesk:wght@400;500;700&family=IBM+Plex+Sans:wght@400;500;600&family=Source+Serif+4:ital,opsz,wght@0,8..60,400;0,8..60,600;1,8..60,400&display=swap" rel="stylesheet">

<style>
:root{--bg:#0a0a0c;--surface:#141418;--text:#e8e6e3;--text-muted:#8a8a8e;--accent:#c4b5fd;--accent-dim:rgba(196,181,253,0.12);--border:#2a2a30;--font-body:'JetBrains Mono','SF Mono',monospace;--font-heading:'JetBrains Mono','SF Mono',monospace;--radius:8px;--max-width:640px}
[data-theme="paper"]{--bg:#faf7f2;--surface:#f0ece4;--text:#2c2a28;--text-muted:#7a7570;--accent:#c45d3e;--accent-dim:rgba(196,93,62,0.08);--border:#e0dbd3;--font-body:'Source Serif 4',Georgia,serif;--font-heading:'Lora',Georgia,serif}
[data-theme="terminal"]{--bg:#0c0c0c;--surface:#111;--text:#33ff33;--text-muted:#1a9a1a;--accent:#33ff33;--accent-dim:rgba(51,255,51,0.06);--border:#1a3a1a;--font-body:'JetBrains Mono','Courier New',monospace;--font-heading:'JetBrains Mono','Courier New',monospace}
[data-theme="dusk"]{--bg:#0f0e1a;--surface:#1a1830;--text:#e4e2f0;--text-muted:#8884a8;--accent:#7c6cf0;--accent-dim:rgba(124,108,240,0.1);--border:#2a2845;--font-body:'IBM Plex Sans','Helvetica Neue',sans-serif;--font-heading:'Space Grotesk','Helvetica Neue',sans-serif}
[data-theme="sunlight"]{--bg:#fff;--surface:#f8f8f8;--text:#1a1a1a;--text-muted:#6b6b6b;--accent:#e8622c;--accent-dim:rgba(232,98,44,0.08);--border:#ebebeb;--font-body:'Inter','Helvetica Neue',system-ui,sans-serif;--font-heading:'Space Grotesk','Helvetica Neue',sans-serif}
*,*::before,*::after{margin:0;padding:0;box-sizing:border-box}
html{font-size:16px;-webkit-font-smoothing:antialiased}
body{font-family:var(--font-body);background:var(--bg);color:var(--text);line-height:1.7;min-height:100vh;display:flex;flex-direction:column;align-items:center;padding:0 1.25rem}
[data-theme="terminal"] body::before{content:'';position:fixed;inset:0;background:repeating-linear-gradient(0deg,transparent,transparent 2px,rgba(0,0,0,.15) 2px,rgba(0,0,0,.15) 4px);pointer-events:none;z-index:100}
[data-theme="dusk"] body{background:linear-gradient(160deg,#0f0e1a 0%,#1a1040 50%,#0f0e1a 100%);background-attachment:fixed}
a{color:var(--accent);text-decoration:none;transition:opacity .2s}a:hover{opacity:.8}
.page{width:100%;max-width:var(--max-width);padding:4rem 0 3rem}
.identity{display:flex;align-items:center;gap:1.25rem;margin-bottom:2rem}
.avatar{width:72px;height:72px;border-radius:50%;border:2px solid var(--border);object-fit:cover;flex-shrink:0;background:var(--surface)}
.identity-text{min-width:0}
.name{font-family:var(--font-heading);font-size:1.5rem;font-weight:700;line-height:1.3;letter-spacing:-.02em}
[data-theme="terminal"] .name::before{content:'> ';color:var(--accent)}
.tagline{font-size:.9rem;color:var(--text-muted);margin-top:.15rem}
.divider{border:none;height:1px;background:var(--border);margin:1.75rem 0}
.section-label{font-family:var(--font-heading);font-size:.7rem;font-weight:600;text-transform:uppercase;letter-spacing:.12em;color:var(--text-muted);margin-bottom:1rem}
[data-theme="terminal"] .section-label::before{content:'$ ';color:var(--accent)}
.now-list{list-style:none;display:flex;flex-direction:column;gap:.6rem}
.now-item{padding:.85rem 1rem;background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);font-size:.92rem;line-height:1.55;position:relative}
.now-item::before{content:'';position:absolute;left:0;top:0;bottom:0;width:3px;background:var(--accent);border-radius:var(--radius) 0 0 var(--radius);opacity:.5}
[data-theme="terminal"] .now-item{background:transparent;border-color:var(--border);border-radius:0}
[data-theme="terminal"] .now-item::before{display:none}
[data-theme="paper"] .now-item{background:transparent;border:none;border-bottom:1px solid var(--border);border-radius:0;padding:.85rem .5rem}
[data-theme="paper"] .now-item::before{display:none}
.socials{display:flex;gap:.5rem;flex-wrap:wrap;margin-top:.5rem}
.social-link{display:inline-flex;align-items:center;gap:.4rem;padding:.45rem .8rem;background:var(--accent-dim);border:1px solid transparent;border-radius:999px;font-size:.78rem;font-family:var(--font-body);color:var(--accent);transition:all .2s}
.social-link:hover{border-color:var(--accent);opacity:1}
.social-link svg{width:14px;height:14px;flex-shrink:0}
[data-theme="terminal"] .social-link{background:transparent;border:1px solid var(--border);border-radius:0;color:var(--text)}
[data-theme="terminal"] .social-link:hover{border-color:var(--accent);color:var(--accent)}
.page-footer{margin-top:auto;padding:2rem 0;text-align:center;width:100%;max-width:var(--max-width)}
.updated{font-size:.75rem;color:var(--text-muted);margin-bottom:.75rem}
[data-theme="terminal"] .updated::before{content:'// '}
.made-with{font-size:.72rem;color:var(--text-muted);opacity:.6}
.made-with a{color:var(--text-muted);border-bottom:1px solid var(--border)}
.made-with a:hover{color:var(--accent);border-color:var(--accent);opacity:1}
@media(max-width:480px){.page{padding:2.5rem 0 2rem}.identity{gap:1rem}.avatar{width:56px;height:56px}.name{font-size:1.25rem}.now-item{font-size:.88rem;padding:.75rem .85rem}}
</style>
</head>
<body>
<article class="page" role="main">
  <header class="identity">
    <img class="avatar" src="${avatar}" alt="${name}" width="72" height="72" loading="eager">
    <div class="identity-text">
      <h1 class="name">${name}</h1>
      ${tag ? `<p class="tagline">${tag}</p>` : ''}
    </div>
  </header>

  <hr class="divider" aria-hidden="true">

  <section aria-labelledby="now-heading">
    <p class="section-label" id="now-heading">What I'm focused on now</p>
    <ul class="now-list">
${focusHTML}
    </ul>
  </section>
${socialSection}
</article>

<footer class="page-footer">
  <p class="updated"><time datetime="${isoDate}">Last updated ${dateStr}</time></p>
  <p class="made-with">Made with <a href="https://nowpages.github.io">NowPages</a> — create yours free</p>
</footer>
</body>
</html>`;
}

// ═════════════════════════════════════════════════════════
//  GITHUB API
// ═════════════════════════════════════════════════════════

async function pushToGitHub(env, handle, htmlContent) {
  const path = `${handle}/index.html`;
  const apiUrl = `https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/contents/${path}`;
  const headers = {
    'Authorization': `Bearer ${env.GITHUB_PAT}`,
    'Accept': 'application/vnd.github.v3+json',
    'User-Agent': 'NowPages-Worker',
  };

  // Get existing file SHA if updating
  let existingSha = null;
  try {
    const checkRes = await fetch(apiUrl, { headers });
    if (checkRes.ok) {
      const data = await checkRes.json();
      existingSha = data.sha;
    }
  } catch (e) { /* file doesn't exist yet */ }

  const payload = {
    message: existingSha ? `Update ${handle}'s now page` : `Create ${handle}'s now page`,
    content: btoa(unescape(encodeURIComponent(htmlContent))),
    branch: 'main',
  };
  if (existingSha) payload.sha = existingSha;

  const res = await fetch(apiUrl, {
    method: 'PUT',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  return { ok: res.ok, status: res.status };
}

// ═════════════════════════════════════════════════════════
//  MANIFEST
// ═════════════════════════════════════════════════════════

async function updateManifest(env, pageData) {
  let manifest = await env.TOKENS.get('manifest', 'json') || [];
  manifest = manifest.filter(p => p.handle !== pageData.handle);
  manifest.unshift({
    handle: pageData.handle,
    displayName: pageData.displayName,
    tagline: pageData.tagline,
    avatarUrl: pageData.avatarUrl,
    updatedAt: pageData.updatedAt,
  });
  manifest = manifest.slice(0, 200);
  await env.TOKENS.put('manifest', JSON.stringify(manifest));

  // Push manifest.json to GitHub for the directory page
  const apiUrl = `https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/contents/manifest.json`;
  const headers = {
    'Authorization': `Bearer ${env.GITHUB_PAT}`,
    'Accept': 'application/vnd.github.v3+json',
    'User-Agent': 'NowPages-Worker',
  };

  let existingSha = null;
  try {
    const checkRes = await fetch(apiUrl, { headers });
    if (checkRes.ok) existingSha = (await checkRes.json()).sha;
  } catch (e) {}

  const payload = {
    message: 'Update manifest',
    content: btoa(unescape(encodeURIComponent(JSON.stringify(manifest, null, 2)))),
    branch: 'main',
  };
  if (existingSha) payload.sha = existingSha;

  await fetch(apiUrl, {
    method: 'PUT',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

// ═════════════════════════════════════════════════════════
//  SECURITY HELPERS
// ═════════════════════════════════════════════════════════

/** Rate limiting using KV with TTL */
async function checkRateLimit(env, key, { max, windowSec }) {
  const now = Math.floor(Date.now() / 1000);
  const data = await env.TOKENS.get(key, 'json');

  if (!data || data.windowStart + windowSec < now) {
    // New window
    await env.TOKENS.put(key, JSON.stringify({ count: 1, windowStart: now }), {
      expirationTtl: windowSec,
    });
    return { ok: true };
  }

  if (data.count >= max) {
    const retryAfter = Math.ceil((data.windowStart + windowSec - now) / 60);
    return { ok: false, retryAfter };
  }

  data.count++;
  await env.TOKENS.put(key, JSON.stringify(data), {
    expirationTtl: windowSec - (now - data.windowStart),
  });
  return { ok: true };
}

/** Timing-safe string comparison to prevent timing attacks on tokens */
function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;

  const encoder = new TextEncoder();
  const bufA = encoder.encode(a);
  const bufB = encoder.encode(b);

  // Constant-time comparison
  let result = 0;
  for (let i = 0; i < bufA.length; i++) {
    result |= bufA[i] ^ bufB[i];
  }
  return result === 0;
}

/** Generate a cryptographically random edit token */
function generateToken() {
  const chars = 'abcdefghijkmnpqrstuvwxyz23456789'; // 31 chars, no ambiguous l/1/0/o
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  let token = '';
  for (const byte of bytes) {
    token += chars[byte % chars.length];
  }
  // Format: xxxx-xxxx-xxxx-xxxx-xxxx-xxxx (easy to copy/paste)
  return token.match(/.{4}/g).join('-');
}

// ═════════════════════════════════════════════════════════
//  INPUT SANITIZATION
// ═════════════════════════════════════════════════════════

/** Sanitize handle: lowercase alphanumeric + hyphens, no leading/trailing hyphens */
function sanitizeHandle(input) {
  if (typeof input !== 'string') return '';
  return input
    .toLowerCase()
    .replace(/[^a-z0-9\-]/g, '')
    .replace(/^-+|-+$/g, '')     // no leading/trailing hyphens
    .replace(/-{2,}/g, '-');      // no consecutive hyphens
}

/** Sanitize text: strip HTML tags, trim, enforce max length */
function sanitizeText(input, maxLen) {
  if (typeof input !== 'string') return '';
  return input
    .replace(/<[^>]*>/g, '')     // strip any HTML tags
    .replace(/[<>"'&]/g, '')     // strip characters that could break HTML context
    .trim()
    .slice(0, maxLen);
}

/** Sanitize URL: only allow http/https, enforce max length */
function sanitizeUrl(input, maxLen) {
  if (typeof input !== 'string') return '';
  const trimmed = input.trim().slice(0, maxLen);
  if (!trimmed) return '';

  // Only allow http:// and https:// URLs
  if (!/^https?:\/\//i.test(trimmed)) return '';

  // Block javascript: and data: URIs that might sneak through
  if (/^(javascript|data|vbscript):/i.test(trimmed)) return '';

  return trimmed;
}

/** Escape HTML entities for safe insertion into HTML */
function escapeHTML(str) {
  if (typeof str !== 'string') return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function jsonResponse(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}
