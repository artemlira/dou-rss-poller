# dou-rss-poller

Small GitHub Actions poller. Every ~5 minutes it asks a private Cloudflare Worker
for the list of RSS feeds, fetches them, and sends the items back to the Worker,
which de-duplicates them and notifies via Telegram.

Configuration lives in repository secrets (`WORKER_URL`, `API_KEY`); nothing
sensitive is stored in this repository.

Run locally: `WORKER_URL=... API_KEY=... node scripts/poller.mjs` (Node 24+).
