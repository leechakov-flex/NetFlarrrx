# NetFlarrrx

Browse what Netflix added recently, by genre, type, rating and theme, and request titles to MonkeyServer through Seerr. A discovery layer only: Seerr stays the system of record, and Sonarr and Radarr do the fulfillment.

Plan: *Netflix Catalog Browser (Seerr Companion) — PRD and Engineering Plan* (v0.2).

## Status

| Milestone | State |
| --- | --- |
| M0: data spike | Done Nov 20, 2026. Go on Watchmode's free plan: 7,211 titles, 29 credits per sync, 99.9% with a TMDB ID. |
| M1: ingest | Deployed Nov 20. Daily sync with noise guards, TMDB enrichment, Seerr mirror, health endpoint. |
| M2: browse UI | Built. Discover rows, Movies and Series with filters, Top rated, title detail with trailers, search. Styled to match Seerr. |
| M3: requests | Deployed. Request movies in one tap, pick seasons for series, passcode-protected, "Hide what I have" filter. |
| M4: thematic rows | Built. Six rule-based rows on Discover (acclaimed, hidden gems, true stories, heists, limited series, short movies), editable in `themes.json`. |

## What runs

One container, one SQLite file in `/data`.

- **Daily sync, 6:23 a.m. Eastern.** Lists all of Netflix US from Watchmode (29 credits) and diffs it against yesterday. New titles get a date added; the first ever sync is the baseline and gets none. A title is removed only after 2 missed syncs; one back within 14 days keeps its date. A failed page makes the run *partial* and nothing changes. A count swing over 10% *holds* the run until you confirm it.
- **TMDB enrichment** after each sync: genres, keywords, ratings, posters, original language. Refreshed every 30 days.
- **Seerr mirror** every 10 minutes: what's available, requested or processing.
- **On first start** (or if no sync ran in the last 24 hours) it syncs immediately. Restarts don't re-sync.

English-original only by default (`LANGUAGE_RULE=en`), applied when reading, so changing it needs no re-sync.

## Deploy on MonkeyServer

### 1. Let MonkeyServer pull the image (once)

CI publishes `ghcr.io/leechakov-flex/netflarrrx` on every push to `main`. The package is private, so log in with a GitHub token that has only `read:packages`:

1. GitHub → Settings → Developer settings → Personal access tokens → Tokens (classic) → Generate new token. Tick **read:packages** only.
2. On MonkeyServer:
   ```bash
   docker login ghcr.io -u leechakov-flex      # paste the token as the password
   ```

### 2. Keys

```bash
mkdir -p ~/server/config/netflarrrx
cd ~/server/compose
cp ~/NetFlarrrx/.env.example netflarrrx.env   # or create it by hand
nano netflarrrx.env                             # 3 keys + APP_PASSCODE; SEERR_URL=http://seerr:5055
chmod 600 netflarrrx.env
```

You can reuse the keys from the spike's `~/NetFlarrrx/.env`.

### 3. Add the service to `~/server/compose/docker-compose.yml`

```yaml
  # ============================================================
  # NETFLARRRX — What's new on Netflix, requests via Seerr
  # Access: http://monkeyserver.local:8484
  # ============================================================
  netflarrrx:
    image: ghcr.io/leechakov-flex/netflarrrx:latest
    container_name: netflarrrx
    user: "1000:1000"
    networks:
      - server_network
    environment:
      - TZ=America/New_York
    env_file:
      - ./netflarrrx.env
    volumes:
      - /home/lee-chakov/server/config/netflarrrx:/data
    ports:
      - 8484:8484
    depends_on:
      - seerr
    restart: unless-stopped
```

### 4. Start it

```bash
cd ~/server/compose
docker compose pull netflarrrx
docker compose up -d netflarrrx
docker logs -f netflarrrx          # first sync + enrichment takes a few minutes
```

Then open <http://monkeyserver.local:8484>.

After updating to M2, the app re-fetches every title from TMDB once (about 4 minutes, free) to pick up trailers and age ratings. Add an **HTTP** monitor in Uptime Kuma for `http://netflarrrx:8484/healthz` (it's on the same network). It returns 503 when a sync is held, failing, or more than 36 hours old.

To update later: `docker compose pull netflarrrx && docker compose up -d netflarrrx`.

### Requests (M3)

Requests go to Seerr with its API key, so they're made as the Seerr admin and approved automatically; Sonarr or Radarr picks them up from there. Set `APP_PASSCODE` in `netflarrrx.env` so only people with the passcode can request: each phone or browser asks once and remembers it. Ten wrong tries from one device pause it for 15 minutes. To make requests as a different Seerr user (so they wait for approval), add `SEERR_USER_ID=<their Seerr user ID>`.

## Thematic rows

Discover shows six rows after *Popular on Netflix*, each defined by a rule. A title joins a row when it matches **any** signal (a TMDB keyword, a genre, or a Watchmode type) and passes **every** limit (kind, year, rating, votes, runtime, seasons, excluded genres or keywords). Names match TMDB's own, ignoring case.

Tune them against your catalog:

```bash
docker exec netflarrrx node dist/cli.js themes              # every row: size, which keywords do the work, samples
docker exec netflarrrx node dist/cli.js themes heists       # one row, 40 samples
docker exec netflarrrx node dist/cli.js keywords robbery    # TMDB keywords containing "robbery", with counts
```

To change them, put a `themes.json` in `~/server/config/netflarrrx/` and restart the container. It replaces the built-in list, in the order given; a broken file is logged and ignored. Start from the defaults in `src/catalog/themes.ts`. Example:

```json
[
  { "slug": "heists", "title": "Heists and cons",
    "signals": { "keywords": ["heist", "bank robbery", "con artist"] },
    "exclude": { "genres": ["Documentary", "Animation"] } },
  { "slug": "eighties", "title": "Made in the 80s", "kind": "movie", "year": { "min": 1980, "max": 1989 }, "sort": "rating" }
]
```

Fields: `slug`, `title`, `kind` (movie or series), `signals` {keywords, genres, types}, `exclude` {keywords, genres}, `year`, `rating`, `votes`, `runtime`, `seasons` (each `{min, max}`), `sort` (added, rating, popularity, release, title), `home` (false keeps it off Discover but under More → Collections).

## Day-to-day commands

```bash
docker exec netflarrrx node dist/cli.js status          # counts, health, last 10 runs
docker exec netflarrrx node dist/cli.js sync            # sync now (29 credits)
docker exec netflarrrx node dist/cli.js confirm <id>    # apply a held run
docker exec netflarrrx node dist/cli.js enrich          # retry TMDB for titles that need it
```

Back up `~/server/config/netflarrrx/` — the date-added history can't be rebuilt. Your existing rsync of `~/server/config/` already covers it.

## Development

```bash
npm ci
npm test                 # unit tests on real (scrubbed) M0 data, plus the spike's tests
npm run typecheck
npx tsx src/test-support/serve-fakes.ts   # fake Watchmode/TMDB/Seerr on ports 18001-18003
```

Point the app at the fakes with `WATCHMODE_BASE=http://127.0.0.1:18001/v1 TMDB_BASE=http://127.0.0.1:18002/3 SEERR_URL=http://127.0.0.1:18003 DATA_DIR=./data`, any keys, and `npm run dev` (API on :8484). Add `FAKE_VARIED=1` to the fakes for varied titles and ratings.

For the web UI, run `npm run dev:web` alongside it: Vite serves the React app with hot reload and proxies `/api` to :8484. The UI lives in `web/` (React, TanStack Query, Tailwind 3 with Seerr's palette and Inter, Heroicons) and builds into `dist/web`, which the server serves.

## M0 spike

`scripts/spike.mjs` checks the three APIs read-only and writes a sanitized report. Results from the Nov 20 run are in `test/fixtures/m0/report.md`. To rerun it on MonkeyServer:

```bash
docker run --rm -it -u 1000:1000 --network compose_server_network \
  -v "$PWD":/app -w /app --env-file .env node:22-slim node scripts/spike.mjs
```

It costs about 29 Watchmode credits and never creates a Seerr request.

---

Data from [Watchmode](https://www.watchmode.com) and [TMDB](https://www.themoviedb.org). This product uses the TMDB API but is not endorsed or certified by TMDB.
