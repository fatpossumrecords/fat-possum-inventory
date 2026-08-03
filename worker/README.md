# fp-gist-proxy

Cloudflare Worker that holds the GitHub Gist PAT and Packiyo API token
server-side, so the browser app (`app.js` etc.) never receives them
directly. It exposes exactly three operations:

- `GET`/`PATCH /gist/e79a142da6ddbc0a77560802db1ce780` → proxies to
  `https://api.github.com/gists/:id`, injecting the real GitHub token.
  Any other gist id is rejected (403) — this is not a general GitHub API proxy.
- `GET`/`POST`/`PATCH /packiyo/*` → proxies to
  `https://fatpossum.app.packiyo.com/api/v1/*`, injecting the real Packiyo
  bearer token.
- `POST /error-log` → appends a client-reported JS error to
  `fp_error_log.json` in the same gist (capped at the 200 most recent).
  Viewable from Settings → Admin → Error Log in the app. Uses the same
  `GIST_TOKEN` secret as the `/gist/*` route — no separate secret needed.

## Deploy

```sh
cd worker
npx wrangler login
npx wrangler deploy
```

Then set the two secrets (use **newly rotated** values — see below, not the
ones that were previously exposed in `app.js`):

```sh
npx wrangler secret put GIST_TOKEN
npx wrangler secret put PACKIYO_TOKEN
```

`wrangler deploy` prints the Worker's URL
(`https://fp-gist-proxy.<your-subdomain>.workers.dev`). Put that in
`app.js`'s `CONFIG.WORKER_BASE`.

## Before deploying: rotate both credentials

The token values that used to live in `app.js` were shipped to every visitor
of a public GitHub Pages site and are sitting in this repo's git history.
Rotate both before putting the new values into Worker secrets:

- **GitHub**: Settings → Developer settings → Fine-grained tokens → revoke
  the old one, issue a new fine-grained PAT scoped to Gists only if possible.
- **Packiyo**: API settings → regenerate the token.

## Updating a token later

Same as above — `npx wrangler secret put GIST_TOKEN` (or `PACKIYO_TOKEN`)
from this directory. No redeploy of the app itself needed.
