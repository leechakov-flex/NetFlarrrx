# MonkeySee

Browse what Netflix added recently, by genre, type, rating and theme, and request titles to MonkeyServer through Seerr. A discovery layer only: Seerr stays the system of record, and Sonarr and Radarr do the fulfillment.

Plan: *Netflix Catalog Browser (Seerr Companion) — PRD and Engineering Plan* (v0.2).

## Status

| Milestone | State |
| --- | --- |
| M0: data spike | Done Nov 20, 2026. Go on Watchmode's free plan: 7,211 titles, 29 credits per sync, 99.9% with a TMDB ID. |
| M1: ingest | Deployed Nov 20. Daily sync with noise guards, TMDB enrichment, Seerr mirror, health endpoint. |
| M2: browse UI | Built. Discover rows, Movies and Series with filters, Top rated, title detail with trailers, search. Styled to match Seerr. |
| M3: requests | Deployed. Request movies in one tap, pick seasons for series, passcode-protected, "Hide what I have" filter. |
| M4: thematic rows | Deployed. Six rule-based rows on Discover (acclaimed, hidden gems, true stories, heists, limited series, short movies), editable in `themes.json`. |
| M5: polish | Deployed. Nightly verified backups, ntfy alerts, weekly TMDB cross-check, add to home screen. A second streaming service is deferred. |
| Discover v2 | Built. A long, new-first Discover page with stand-up and comedy up top, recent genre rows, and recommendations from your library. |

## What runs

One container, one SQLite file in `/data`.

- **Daily sync, 6:23 a.m. Eastern.** Lists all of Netflix US from Watchmode (29 credits) and diffs it against yesterday. New titles get a date added; the first ever sync is the baseline and gets none. A title is removed only after 2 missed syncs; one back within 14 days keeps its date. A failed page makes the run *partial* and nothing changes. A count swing over 10% *holds* the run until you confirm it.
- **TMDB enrichment** after each sync: genres, keywords, ratings, posters, original language. Refreshed every 30 days.
- **Seerr mirror** every 10 minutes: what's available, requested or processing.
- **On first start** (or if no sync ran in the last 24 hours) it syncs immediately. Restarts don't re-sync.

English-original only by default (`LANGUAGE_RULE=en`), applied when reading, so changing it needs no re-sync.

## Moving from NetFlarrrx (Nov 21, 2026)

The app was called NetFlarrrx. The image is now `ghcr.io/leechakov-flex/monkeysee`, and the old one stops getting updates. Nothing is lost: on its first start MonkeySee renames `netflarrrx.sqlite` to `monkeysee.sqlite`, old `netflarrrx-*.sqlite` backups age out as usual, and phones keep their saved passcode. On MonkeyServer, once, one command at a time:

```bash
cd ~/server/compose
docker compose stop netflarrrx && docker compose rm -f netflarrrx
mv ~/server/config/netflarrrx ~/server/config/monkeysee
mv netflarrrx.env monkeysee.env
nano docker-compose.yml   # in the netflarrrx block: rename the service and container_name to monkeysee,
                          # image to ghcr.io/leechakov-flex/monkeysee:latest, env_file to ./monkeysee.env,
                          # and the volume to /home/lee-chakov/server/config/monkeysee:/data
docker compose pull monkeysee
docker compose up -d monkeysee
docker logs --tail 50 monkeysee   # look for "listening"; there's no re-sync
```

Then update anything that points at the old name: the Uptime Kuma monitor (`http://monkeysee:8484/healthz`), the Homepage tile, and the Remote Control handoff (`cp ~/MonkeySee/ops/claude/CLAUDE.md ~/server/compose/CLAUDE.md` once the source folder is renamed). On the phone, delete the old home-screen icon and add it again to get the new name and icon.

## Deploy on MonkeyServer

### 1. Let MonkeyServer pull the image (once)

CI publishes `ghcr.io/leechakov-flex/monkeysee` on every push to `main`. The package is private, so log in with a GitHub token that has only `read:packages`:

1. GitHub → Settings → Developer settings → Personal access tokens → Tokens (classic) → Generate new token. Tick **read:packages** only.
2. On MonkeyServer:
   ```bash
   docker login ghcr.io -u leechakov-flex      # paste the token as the password
   ```

### 2. Keys

```bash
mkdir -p ~/server/config/monkeysee
cd ~/server/compose
cp ~/MonkeySee/.env.example monkeysee.env   # or create it by hand
nano monkeysee.env                             # 3 keys + APP_PASSCODE; SEERR_URL=http://seerr:5055
chmod 600 monkeysee.env
```

You can reuse the keys from the spike's `~/MonkeySee/.env`.

### 3. Add the service to `~/server/compose/docker-compose.yml`

```yaml
  # ============================================================
  # MONKEYSEE — What's new on Netflix, requests via Seerr
  # Access: http://monkeyserver.local:8484
  # ============================================================
  monkeysee:
    image: ghcr.io/leechakov-flex/monkeysee:latest
    container_name: monkeysee
    user: "1000:1000"
    networks:
      - server_network
    environment:
      - TZ=America/New_York
    env_file:
      - ./monkeysee.env
    volumes:
      - /home/lee-chakov/server/config/monkeysee:/data
    ports:
      - 8484:8484
    depends_on:
      - seerr
    restart: unless-stopped
```

### 4. Start it

```bash
cd ~/server/compose
docker compose pull monkeysee
docker compose up -d monkeysee
docker logs -f monkeysee          # first sync + enrichment takes a few minutes
```

Then open <http://monkeyserver.local:8484>.

After updating to M2, the app re-fetches every title from TMDB once (about 4 minutes, free) to pick up trailers and age ratings. Add an **HTTP** monitor in Uptime Kuma for `http://monkeysee:8484/healthz` (it's on the same network). It returns 503 when a sync is held, failing, or more than 36 hours old.

To update later: `docker compose pull monkeysee && docker compose up -d monkeysee`.

### Requests (M3)

Requests go to Seerr with its API key, so they're made as the Seerr admin and approved automatically; Sonarr or Radarr picks them up from there. Set `APP_PASSCODE` in `monkeysee.env` so only people with the passcode can request: each phone or browser asks once and remembers it. Ten wrong tries from one device pause it for 15 minutes. To make requests as a different Seerr user (so they wait for approval), add `SEERR_USER_ID=<their Seerr user ID>`.

## Discover

Discover is a deliberately long page of about 30 rows, newest first:

1. **New on Netflix:** new this week and this month (from the daily sync; these fill in as history builds), new movies (released in the last 4 months), new episodes and seasons (aired in the last 45 days), new Netflix originals.
2. **Recommended for you,** then *Because you have …* rows spread down the page.
3. **Comedy:** stand-up specials, new comedy movies, comedy series.
4. **Popular now, by genre:** action, thrillers, crime, sci-fi and fantasy, horror, dramas, romance, documentaries, reality, animation, family. Genre rows only take titles from the last 2 to 3 years, so old catalogue hits don't crowd out new ones.
5. **Themes:** true stories, heists, limited series, hidden gems, short movies, critically acclaimed, and all-time popular at the very end.

"Newest added" sorting puts dated arrivals first, then titles by their latest release or episode.

### Recommended for you

Your library is every movie Radarr has a file for and every series Sonarr has episodes of, plus anything Seerr shows as available. Set `RADARR_API_KEY` and `SONARR_API_KEY` in `monkeysee.env` (each app: Settings → General → API Key); without them only Seerr's list is used, which can be much smaller. MonkeySee only reads from them. After each daily sync it refreshes the library and asks TMDB, once per title, what people who liked it also liked (free; cached for 60 days). A Netflix title scores higher the more of your titles recommend it and the higher it ranks; anything you already have or requested is left out, as is anything rated under 6 or with fewer than 30 votes, and anything over 10 years old unless it's rated 7.5 or higher. Titles from the last two years get a 1.5× boost. *Because you have X* rows use your most recently added titles with the most Netflix matches, mixed: at most one stand-up special, then a series and another movie.

```bash
docker exec monkeysee node dist/cli.js recs     # refresh now and show the top picks
```

## Rows and rules

Each Discover row is defined by a rule. A title joins a row when it matches **any** signal (a TMDB keyword, a genre, or a Watchmode type) and passes **every** limit (kind, year, rating, votes, runtime, seasons, excluded genres or keywords). Names match TMDB's own, ignoring case.

Tune them against your catalog:

```bash
docker exec monkeysee node dist/cli.js themes              # every row: size, which keywords do the work, samples
docker exec monkeysee node dist/cli.js themes heists       # one row, 40 samples
docker exec monkeysee node dist/cli.js keywords robbery    # TMDB keywords containing "robbery", with counts
```

To change them, put a `themes.json` in `~/server/config/monkeysee/` and restart the container. It replaces the built-in list, in the order given; a broken file is logged and ignored. Start from the defaults in `src/catalog/themes.ts`. Example:

```json
[
  { "slug": "heists", "title": "Heists and cons",
    "signals": { "keywords": ["heist", "bank robbery", "con artist"] },
    "exclude": { "genres": ["Documentary", "Animation"] } },
  { "slug": "eighties", "title": "Made in the 80s", "kind": "movie", "year": { "min": 1980, "max": 1989 }, "sort": "rating" }
]
```

Fields: `slug`, `title`, `kind` (movie or series), `signals` {keywords, genres, types}, `require` {genres}, `exclude` {keywords, genres, types}, `year`, `rating`, `votes`, `runtime`, `seasons` (each `{min, max}`), `released` / `aired` (`{withinDays}`), `originals` (true or false), `addedWithin` (days), `sort` (added, rating, popularity, release, title, match), `home` (false keeps it off Discover but under More → Collections), `special` (for-you or because). A `themes.json` replaces the whole list, so copy the defaults from `src/catalog/themes.ts` and change from there.

## Backups, alerts and the TMDB cross-check

- **Backups, nightly at 3:41.** A consistent copy of the database (`VACUUM INTO`), checked with SQLite's integrity check before it replaces anything, into `/data/backups` (newest 14 kept). Also taken on the first start after an update. To keep copies on the external drive, add a second volume, e.g. `- /mnt/external/monkeysee-backups:/backups`, and set `BACKUP_DIR=/backups`. To restore: stop the container, copy a backup over `~/server/config/monkeysee/monkeysee.sqlite`, start it.
- **Alerts.** Set `ALERT_URL` to an ntfy topic (install the ntfy app and subscribe to the same topic; pick a long random name, since anyone who knows it can read it) or a Discord webhook. MonkeySee sends one message when something goes wrong, a reminder after a day, and one when it's fixed: sync held, failing or overdue; backup failed or older than 2 days; cross-check failed or low. `docker exec monkeysee node dist/cli.js alert-test` checks the setup.
- **TMDB cross-check, Sundays at 5:17.** Lists every title TMDB (JustWatch data) has on Netflix US and compares it with ours. It alerts when we have under 70% of TMDB's list (82% at the Nov 20 baseline), when under 85% of ours is on TMDB's (97% baseline: a sign of titles that left Netflix), or after a 10-point drop. `docker exec monkeysee node dist/cli.js crosscheck` runs it now and shows the most popular titles each side is missing, for a spot check on JustWatch.

The More tab shows the last backup, the cross-check match and whether alerts are on.

## Add to home screen

On iPhone: open the app in Safari, Share → Add to Home Screen. It opens full screen with its own icon. Over plain `http://` the service worker (offline shell) can't run; that switches on by itself once the app is served over HTTPS (Tailscale, later).

## Day-to-day commands

```bash
docker exec monkeysee node dist/cli.js status          # counts, health, last 10 runs
docker exec monkeysee node dist/cli.js sync            # sync now (29 credits)
docker exec monkeysee node dist/cli.js confirm <id>    # apply a held run
docker exec monkeysee node dist/cli.js enrich          # retry TMDB for titles that need it
docker exec monkeysee node dist/cli.js backup          # take a backup now
docker exec monkeysee node dist/cli.js crosscheck      # compare with TMDB's Netflix list
docker exec monkeysee node dist/cli.js alerts          # what would alert right now
```

The date-added history can't be rebuilt, so keep the nightly backups somewhere other than the main disk too (see above). Your rsync of `~/server/config/` to the Mac also covers it.

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
