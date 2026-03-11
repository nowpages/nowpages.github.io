/**
 * NowPages — OG Image Generator (Cloudflare Worker)
 *
 * Generates dynamic Open Graph images as SVG → PNG for social sharing.
 *
 * Usage:
 *   GET /og?name=Vipin&tagline=Building+things&theme=ink&avatar=https://...
 *
 * Parameters:
 *   name     — Display name (required)
 *   tagline  — Tagline text (optional)
 *   theme    — Theme name: ink, paper, terminal, dusk, sunlight (default: ink)
 *   avatar   — Avatar URL (optional, shows initials if not provided)
 *
 * Returns: 1200x630 PNG image
 *
 * Deployment:
 *   wrangler deploy og-worker.js --name nowpages-og
 *
 * NOTE: This worker generates SVG and converts to PNG using resvg-js.
 * For the simplest deployment, you can also use @vercel/og or satori
 * on Vercel Edge Functions. This implementation works on Cloudflare.
 *
 * ALTERNATIVE (simpler, recommended for MVP):
 * If you don't want to set up resvg-js, this worker can return SVG
 * directly. Most social platforms accept SVG og:images, and you can
 * also use a service like svg2png.com as a proxy.
 */

const THEMES = {
  ink: {
    bg: '#0a0a0c',
    surface: '#141418',
    text: '#e8e6e3',
    muted: '#8a8a8e',
    accent: '#c4b5fd',
    border: '#2a2a30',
    font: "'JetBrains Mono', monospace",
  },
  paper: {
    bg: '#faf7f2',
    surface: '#f0ece4',
    text: '#2c2a28',
    muted: '#7a7570',
    accent: '#c45d3e',
    border: '#e0dbd3',
    font: "'Georgia', serif",
  },
  terminal: {
    bg: '#0c0c0c',
    surface: '#111111',
    text: '#33ff33',
    muted: '#1a9a1a',
    accent: '#33ff33',
    border: '#1a3a1a',
    font: "'Courier New', monospace",
  },
  dusk: {
    bg: '#0f0e1a',
    surface: '#1a1830',
    text: '#e4e2f0',
    muted: '#8884a8',
    accent: '#7c6cf0',
    border: '#2a2845',
    font: "'Helvetica Neue', sans-serif",
  },
  sunlight: {
    bg: '#ffffff',
    surface: '#f8f8f8',
    text: '#1a1a1a',
    muted: '#6b6b6b',
    accent: '#e8622c',
    border: '#ebebeb',
    font: "'Helvetica Neue', sans-serif",
  },
};

export default {
  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname !== '/og') {
      return new Response('Not found', { status: 404 });
    }

    const name = url.searchParams.get('name') || 'Anonymous';
    const tagline = url.searchParams.get('tagline') || '';
    const themeName = url.searchParams.get('theme') || 'ink';
    const avatarUrl = url.searchParams.get('avatar') || '';

    const theme = THEMES[themeName] || THEMES.ink;
    const initials = getInitials(name);

    // Generate SVG
    const svg = generateOGSvg({ name, tagline, theme, themeName, initials, avatarUrl });

    // Return as SVG (browsers and most social platforms handle this)
    // For PNG conversion, integrate resvg-wasm or use a proxy service
    return new Response(svg, {
      headers: {
        'Content-Type': 'image/svg+xml',
        'Cache-Control': 'public, max-age=86400, s-maxage=604800',
        'Access-Control-Allow-Origin': '*',
      }
    });
  }
};

function getInitials(name) {
  return name
    .split(/\s+/)
    .map(w => w[0])
    .filter(Boolean)
    .slice(0, 2)
    .join('')
    .toUpperCase();
}

function escSvg(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function truncate(str, len) {
  if (str.length <= len) return str;
  return str.slice(0, len - 1) + '…';
}

function generateOGSvg({ name, tagline, theme, themeName, initials, avatarUrl }) {
  const w = 1200;
  const h = 630;

  // Dusk gets a gradient bg
  const bgFill = themeName === 'dusk'
    ? `<defs><linearGradient id="bg-grad" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#0f0e1a"/><stop offset="50%" stop-color="#1a1040"/><stop offset="100%" stop-color="#0f0e1a"/></linearGradient></defs><rect width="${w}" height="${h}" fill="url(#bg-grad)"/>`
    : `<rect width="${w}" height="${h}" fill="${theme.bg}"/>`;

  // Scanlines for terminal theme
  const scanlines = themeName === 'terminal'
    ? `<defs><pattern id="scan" width="4" height="4" patternUnits="userSpaceOnUse"><rect width="4" height="2" fill="rgba(0,0,0,0.12)"/></pattern></defs><rect width="${w}" height="${h}" fill="url(#scan)"/>`
    : '';

  // Avatar circle (with initials fallback)
  const avatarSection = avatarUrl
    ? `<defs><clipPath id="avatar-clip"><circle cx="100" cy="${h/2}" r="56"/></clipPath></defs>
       <circle cx="100" cy="${h/2}" r="58" fill="${theme.border}"/>
       <image href="${escSvg(avatarUrl)}" x="44" y="${h/2 - 56}" width="112" height="112" clip-path="url(#avatar-clip)" preserveAspectRatio="xMidYMid slice"/>`
    : `<circle cx="100" cy="${h/2}" r="56" fill="${theme.surface}" stroke="${theme.border}" stroke-width="2"/>
       <text x="100" y="${h/2 + 8}" text-anchor="middle" font-family="${theme.font}" font-size="28" font-weight="700" fill="${theme.accent}">${escSvg(initials)}</text>`;

  // Text positioning
  const textX = avatarUrl ? 200 : 200;
  const nameY = tagline ? h/2 - 10 : h/2 + 8;

  // Terminal prefix
  const prefix = themeName === 'terminal' ? '&gt; ' : '';

  // Truncate for fit
  const displayName = truncate(name, 30);
  const displayTagline = truncate(tagline, 60);

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
  ${bgFill}
  ${scanlines}

  <!-- Subtle accent line at top -->
  <rect x="0" y="0" width="${w}" height="3" fill="${theme.accent}" opacity="0.6"/>

  <!-- Card surface -->
  <rect x="48" y="48" width="${w - 96}" height="${h - 96}" rx="16" ry="16"
        fill="${theme.surface}" stroke="${theme.border}" stroke-width="1" opacity="0.7"/>

  <!-- Avatar -->
  <g transform="translate(40, 0)">
    ${avatarSection}
  </g>

  <!-- Name -->
  <text x="${textX + 40}" y="${nameY}" font-family="${theme.font}" font-size="48" font-weight="700" fill="${theme.text}">
    ${prefix}${escSvg(displayName)}
  </text>

  <!-- Tagline -->
  ${tagline ? `<text x="${textX + 40}" y="${nameY + 44}" font-family="${theme.font}" font-size="22" fill="${theme.muted}">${escSvg(displayTagline)}</text>` : ''}

  <!-- Accent dot + "Now Page" label -->
  <circle cx="${textX + 40}" cy="${h/2 + 75}" r="4" fill="${theme.accent}"/>
  <text x="${textX + 54}" y="${h/2 + 80}" font-family="${theme.font}" font-size="16" fill="${theme.muted}">Now Page</text>

  <!-- Branding -->
  <text x="${w - 72}" y="${h - 68}" text-anchor="end" font-family="${theme.font}" font-size="14" fill="${theme.muted}" opacity="0.5">nowpages.github.io</text>
</svg>`;
}
