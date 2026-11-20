# NetFlarrrx

Browse what Netflix US added recently, by genre, type, rating and theme, and request titles to MonkeyServer through Seerr. A discovery layer only: Seerr stays the system of record, and Sonarr and Radarr do the fulfillment.

Plan: *Netflix Catalog Browser (Seerr Companion) — PRD and Engineering Plan* (v0.2).

## Status

**M0: done (Nov 20, 2026).** Go on Watchmode's free plan: 7,211 Netflix US titles, 29 credits per sync, 99.9% with a TMDB ID. Real responses, scrubbed, are in `test/fixtures/m0/`. Next: M1 ingest.

## M0: run the spike

It needs three keys:

| Key | Where to get it |
| --- | --- |
| `WATCHMODE_API_KEY` | Free Developer key at <https://api.watchmode.com/requestApiKey/>. Choose **US** as one of your 3 countries. |
| `TMDB_READ_TOKEN` | The **API Read Access Token** (the long one) at <https://www.themoviedb.org/settings/api>. |
| `SEERR_API_KEY` | Seerr → Settings → General → API Key. |

### On MonkeyServer (recommended)

Runs in a throwaway Node container on the same network as Seerr, so nothing is installed on the host.

```bash
cd ~/NetFlarrrx
cp .env.example .env
nano .env            # fill in the three keys; set SEERR_URL=http://seerr:5055

docker run --rm -it -u 1000:1000 \
  --network compose_server_network \
  -v "$PWD":/app -w /app --env-file .env \
  node:22-slim node scripts/spike.mjs
```

### On a Mac with Node 20 or later

```bash
cp .env.example .env   # keep SEERR_URL=http://monkeyserver.local:5055
node scripts/spike.mjs
```

### What it does

- **Watchmode:** reads your quota (free), then lists every Netflix US title, 250 per page. Costs about 1 credit per page, roughly 30 of your 2,500 monthly credits.
- **TMDB:** confirms Netflix's provider ID, reads TMDB's own Netflix-US counts, and fetches details for 60 sampled titles (`--sample N` to change).
- **Seerr:** reads version, API-key identity, public settings, the first page of media and requests, and one movie and one series lookup. **It never creates a request.**

Output goes to `spike-output/`: `report.md` (human summary), `report.json`, and `fixtures/` (raw responses for tests). Keys, emails, tokens and avatars are stripped. Zip the folder and send it back.

Options: `--skip-crawl` (quota check only, 0 Watchmode credits), `--max-pages N`, `--out DIR`.

## Tests

```bash
npm run test:spike   # runs the spike against local mock APIs; no keys or network needed
```
