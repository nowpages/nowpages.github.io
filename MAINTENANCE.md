# NowPages Maintenance Guide

> Everything you need to keep NowPages running smoothly.

---

## Routine Maintenance

### GitHub Personal Access Token (PAT)

The worker uses a GitHub PAT to push files to the repo. Classic PATs expire based on the expiration you set when creating them.

**When it expires:** All publishes and edits will fail with a 500 error. Existing pages remain live (they're static files on GitHub Pages), but no new pages can be created or updated.

**How to rotate:**

1. Go to [github.com/settings/tokens](https://github.com/settings/tokens)
2. Click "Generate new token (classic)"
3. Name it something like `nowpages-worker-2026`
4. Select the `repo` scope (full control of private repositories — needed for Contents API)
5. Set expiration (recommended: 90 days, or "No expiration" if you accept the risk)
6. Copy the token immediately (it's shown only once)
7. Update the worker secret:
   ```bash
   cd /path/to/nowpages.github.io
   wrangler secret put GITHUB_PAT
   ```
8. Paste the new token when prompted
9. The change takes effect immediately — no redeployment needed

**Recommendation:** Set a calendar reminder 1 week before expiration. If you use "No expiration," review and rotate annually as a security practice.

### Checking Worker Health

**Cloudflare Dashboard:**

1. Log in to [dash.cloudflare.com](https://dash.cloudflare.com)
2. Go to Workers & Pages → nowpages-api
3. Check the "Metrics" tab for request counts, error rates, and CPU time
4. Check "Logs" tab (real-time) to see request/response details

**Quick health check from terminal:**

```bash
# Test publish endpoint is responding
curl -X OPTIONS https://nowpages-api.nowpages.workers.dev/publish

# Test manifest endpoint
curl https://nowpages-api.nowpages.workers.dev/manifest

# Test instant page serving
curl https://nowpages-api.nowpages.workers.dev/page/vipin
```

### Monitoring Free Tier Usage

Check these periodically in the Cloudflare dashboard:

- **Workers → Metrics**: Daily request count (limit: 100,000/day)
- **Workers → KV → Metrics**: Read and write operations (limits: 100,000 reads/day, 1,000 writes/day)

If you approach limits, consider upgrading to the Workers Paid plan ($5/month) which raises limits to 10 million requests/month and unlimited KV reads.

---

## Common Issues and Fixes

### "Failed to publish" Error

**Possible causes:**

1. **Expired PAT** — rotate it (see above)
2. **Rate limited** — user hit 5 publishes in 60 seconds; wait and retry
3. **GitHub API down** — check [githubstatus.com](https://githubstatus.com); pages will queue in KV but fail on GitHub push
4. **KV write limit exceeded** — if you hit 1,000 writes/day, publishes fail; wait until UTC midnight for reset

**Debugging:** Check worker logs in Cloudflare Dashboard → Workers → nowpages-api → Logs (real-time).

### Page Shows 404 on GitHub Pages

**Right after publishing:** This is expected. GitHub Pages takes 30-60 seconds to deploy. The instant preview URL (`nowpages-api.nowpages.workers.dev/page/{handle}`) works immediately.

**Persistent 404:** Check if the file actually exists in the GitHub repo. Go to `github.com/nowpages/nowpages.github.io/tree/main/{handle}/index.html`. If missing, the GitHub push failed — check worker logs.

### Edit Token Lost

There is no recovery mechanism by design (no email, no accounts). If a user loses their edit token:

- The edit token is stored in KV under `page:{handle}` — you can retrieve it manually:
  ```bash
  wrangler kv key get --namespace-id 5ad833c0c6be45c8bb112901e2fa92c2 "page:{handle}" | jq .editToken
  ```
- You could provide this to the user after verifying their identity (e.g., if they can prove they own the social links on the page)
- Alternatively, you can delete the KV entry and let them re-register the handle

### CORS Errors in Browser Console

If the landing page can't reach the worker:

1. Verify `ALLOWED_ORIGIN` in `wrangler.toml` matches the exact origin (including `https://`)
2. If testing locally, temporarily add `http://localhost:*` or use a CORS browser extension
3. Redeploy after changes: `wrangler deploy`

### Worker Deployment Fails

```bash
# Common fix: re-login
wrangler login

# Check config
wrangler whoami

# Deploy with verbose logging
wrangler deploy --log-level debug
```

---

## Making Changes

### Adding a New Theme

1. **Choose a name** (lowercase, one word, e.g., `ocean`)

2. **Update `worker.js`** — add the theme to the `getThemeStyles()` function:
   ```javascript
   case 'ocean':
     return {
       bg: '#0b132b', text: '#d4e4f7', accent: '#5bc0be',
       secondaryBg: '#1c2541', mutedText: '#8b9dc3',
       fontUrl: 'https://fonts.googleapis.com/css2?family=...&display=swap',
       fontFamily: "'Your Font', sans-serif",
     };
   ```

3. **Update `worker.js`** — add `'ocean'` to the `VALID_THEMES` array

4. **Update `index.html`** — add a theme button in the theme picker bar and matching CSS variables in the preview's `generatePageHTML()` function

5. **Update `og-worker.js`** — add theme colors to the OG image generator

6. **Deploy:** `wrangler deploy`

7. **Commit and push** the updated `index.html`

### Updating the Page Template

The HTML template lives inside `worker.js` in the `generatePageHTML()` function. Any changes to the page layout, styles, or structure go there.

After changes:

```bash
wrangler deploy
```

Existing pages are not automatically updated — they're static files on GitHub. To update an existing page, the user needs to edit and re-publish. If you want to update all pages, you'd need to write a script that re-generates each page from its stored metadata.

### Adding New Form Fields

1. Add the input field in `index.html`
2. Include it in the payload sent to `/publish`
3. Update `worker.js` to validate and sanitize the new field
4. Update the HTML template in `generatePageHTML()` to render it
5. Update the manifest if the field should appear in the directory

### Custom Domain Setup

To use a custom domain (e.g., `now.yourdomain.com`):

**For GitHub Pages (static pages):**

1. Add a `CNAME` file to the repo root containing your domain
2. Configure DNS: CNAME record pointing to `nowpages.github.io`
3. Enable HTTPS in repo Settings → Pages

**For Workers (API + instant pages):**

1. In Cloudflare Dashboard → Workers → nowpages-api → Settings → Domains & Routes
2. Add a custom domain (e.g., `api.yourdomain.com`)
3. Update `WORKER_URL` in `index.html` to the new domain
4. Update `ALLOWED_ORIGIN` in `wrangler.toml` if the landing page domain changes

---

## Handling Abuse

### Spam Pages

If someone publishes spam or inappropriate content:

1. Delete the page from GitHub:
   ```bash
   # Via GitHub UI: navigate to {handle}/index.html → delete
   # Or via API/git: remove the directory and push
   ```

2. Remove from KV:
   ```bash
   wrangler kv key delete --namespace-id 5ad833c0c6be45c8bb112901e2fa92c2 "page:{handle}"
   wrangler kv key delete --namespace-id 5ad833c0c6be45c8bb112901e2fa92c2 "html:{handle}"
   ```

3. Update the manifest:
   ```bash
   # Fetch current manifest
   wrangler kv key get --namespace-id 5ad833c0c6be45c8bb112901e2fa92c2 "manifest" > manifest.json
   # Edit to remove the entry, then put it back
   wrangler kv key put --namespace-id 5ad833c0c6be45c8bb112901e2fa92c2 "manifest" --path manifest.json
   ```

### Blocking a Handle

To prevent a handle from being re-registered after removal, set a tombstone in KV:

```bash
wrangler kv key put --namespace-id 5ad833c0c6be45c8bb112901e2fa92c2 "page:{handle}" '{"blocked":true}'
```

The worker will see this handle as "taken" and reject new registrations.

### Rate Limit Tuning

The current limit is 5 requests per IP per 60 seconds. To change it, edit these constants in `worker.js`:

```javascript
const RATE_LIMIT_MAX = 5;    // max requests per window
const RATE_LIMIT_WINDOW = 60; // window in seconds
```

Redeploy after changes.

---

## Backup and Recovery

### What to Back Up

- **GitHub repo**: Already version-controlled. All generated pages are plain HTML files in the repo.
- **KV data**: Not automatically backed up. The critical data is edit tokens (`page:{handle}` keys).

### Exporting KV Data

```bash
# List all keys
wrangler kv key list --namespace-id 5ad833c0c6be45c8bb112901e2fa92c2

# Export a specific key
wrangler kv key get --namespace-id 5ad833c0c6be45c8bb112901e2fa92c2 "page:vipin"
```

For a full backup, script the key list and iterate through all `page:*` keys.

### Disaster Recovery

If the worker goes down, existing pages on GitHub Pages continue to work. Only new publishes and edits are affected. To recover:

1. Verify Cloudflare account access
2. Re-deploy: `wrangler deploy`
3. If KV data is lost, pages still exist on GitHub but edit tokens are gone — users would need new handles or manual token resets

---

## Scaling Notes

The free tier comfortably supports:

- ~200 new pages/day (limited by KV writes)
- ~100,000 page views/day via the instant serving endpoint
- Unlimited page views via GitHub Pages (separate infrastructure)

If you outgrow the free tier, the Cloudflare Workers Paid plan ($5/month) removes most limits. GitHub Pages has a soft limit of 100 GB bandwidth/month which is very generous for small HTML pages.

The architecture is intentionally simple and stateless — there's no database to migrate, no server to scale. The only stateful component is KV, which Cloudflare manages globally.
