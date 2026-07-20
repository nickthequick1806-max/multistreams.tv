# Multistreams.tv

Multistreams.tv is a multi-platform livestream dashboard with Cloudflare-backed accounts, profiles, privacy controls, layouts, watch-time collectibles, real provider data, and AI-assisted stream discovery.

## Architecture

- Cloudflare Worker serves both the site and `/api/*` routes.
- D1 stores accounts, sessions, settings, layouts, profiles, OAuth connections, follows, blocks, rewards, and notifications.
- R2 stores uploaded profile avatars and banners.
- Provider/API credentials are Worker secrets and are never shipped to the browser.
- Passwords use PBKDF2-SHA-256; sessions use hashed opaque tokens; OAuth and TOTP secrets use AES-GCM encryption.

## Local development

1. Install dependencies with `npm install`.
2. Copy `.env.example` to `.dev.vars` and add development credentials.
3. Apply the local schema with `npx wrangler d1 migrations apply multistreams-production --local`.
4. Run `npm run dev`.

Set `REWARD_DEVELOPER_MODE=true` only in local development to remove reward wait/cooldown limits. Production is pinned to `false` in `wrangler.jsonc`.

## Verification

- `npm test` runs crypto, TOTP, collectible-catalog, secret-leak, and frontend parse checks.
- `npm run check` builds the static assets, generates Worker types, and performs a Wrangler deployment dry run.
- `npm run test:integration` exercises the Worker against local D1/R2, including account signup/login, TOTP, profiles, media, layouts, privacy data, and unique reward claims.

## Production setup

Create `multistreams-production` in D1 and `multistreams-media` in R2, update the generated D1 database ID in `wrangler.jsonc`, apply migrations remotely, and set every secret listed in `.env.example` with `wrangler secret put`.

OAuth callback URLs:

- `https://multistreams.tv/api/oauth/google/callback`
- `https://multistreams.tv/api/oauth/youtube/callback`
- `https://multistreams.tv/api/oauth/twitch/callback`
- `https://multistreams.tv/api/oauth/kick/callback`

The apex domain is served by the Cloudflare Worker custom-domain route. The GitHub repository homepage points to `https://multistreams.tv`; GitHub Pages is intentionally not used because it cannot run the Worker/D1/R2 backend.

## Provider boundaries

Twitch supports followed-live streams, channels, categories, and clips. YouTube subscriptions are checked individually for active broadcasts and are quota-sensitive. Kick's official API does not currently expose viewer follows or clips. Rumble provides a creator-owned private Live Stream API URL rather than public viewer OAuth/browse APIs. Optional third-party Rumble search and YouTube Shorts requests are proxied through the Worker when `SCRAPECREATORS_API_KEY` is configured.
