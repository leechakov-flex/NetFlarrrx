# MonkeyServer: notes for Claude

You're running on MonkeyServer (Ubuntu 24.04, home server) in `~/server/compose`, through Remote
Control. The owner, Lee, approves each command from the Claude app. Keep replies short and say
what you're about to run and why.

## Layout

- Docker Compose stack: `~/server/compose/docker-compose.yml` (network `server_network`, which
  Docker names `compose_server_network`).
- App config and data: `~/server/config/<app>/`. Media: `/mnt/external/media/` (exFAT, mounts need `:shared`).
- Services include Plex, Jellyfin, Seerr (`seerr:5055`), Sonarr (`sonarr:8989`), Radarr
  (`radarr:7878`), Prowlarr, qBittorrent behind a VPN, Pi-hole, Uptime Kuma, Homepage, and MonkeySee.
- MonkeySee source: `~/MonkeySee` (GitHub `leechakov-flex/MonkeySee`). CI publishes
  `ghcr.io/leechakov-flex/monkeysee:latest` on every push to `main`; the server just pulls it.

## MonkeySee

Discover what's new on Netflix US and request it through Seerr. One container, SQLite in
`~/server/config/monkeysee/` (`/data` inside). Web UI: http://monkeyserver.local:8484.

```bash
cd ~/server/compose && docker compose pull monkeysee && docker compose up -d monkeysee   # update
docker logs --tail 100 monkeysee
docker exec monkeysee node dist/cli.js status       # health, counts, last 10 syncs
docker exec monkeysee node dist/cli.js recs         # refresh library + top recommendations
docker exec monkeysee node dist/cli.js library      # library titles: stand-up/movie/series + Netflix matches
docker exec monkeysee node dist/cli.js themes [slug]  # Discover rows: size, keywords, samples
docker exec monkeysee node dist/cli.js keywords <text>
docker exec monkeysee node dist/cli.js crosscheck   # compare with TMDB's Netflix list
docker exec monkeysee node dist/cli.js backup | alerts | alert-test
```

Schedules (America/New_York): sync 6:23 a.m. (costs ~29 of 2,500 monthly Watchmode credits, so
don't run `sync` casually), Seerr mirror every 10 min, backup 3:41 a.m., TMDB cross-check Sundays
5:17 a.m., alert check hourly. Alerts go to ntfy.

Open checks:
- M1: the second-day sync (after 6:23 a.m. on Nov 21, 2026) should be `complete` with a plausible diff.
- M5: 14 days with no alerts; spot-check cross-check misses on JustWatch.
- Recommendations: are the "Because you have" rows mixed (one stand-up special at most)?

When a change to MonkeySee's code is needed, describe it and let Lee take it to the chat where
it's being built; don't edit `~/MonkeySee` here unless asked.

## Rules

- Never print, `cat`, `grep` or copy secrets: `~/server/compose/*.env`, `.env` files, app
  `config.xml` files, API keys, tokens, passwords. To check a setting exists, count it
  (`grep -c '^ALERT_URL=' file`) or print only its name.
- Don't run `docker compose down`, `docker system prune`, or anything that stops or deletes the
  whole stack, and don't delete media or app config. Restart one service at a time by name.
- Don't change Sonarr, Radarr, Seerr or Plex settings, or create Seerr requests, unless Lee asks.
- Paste multi-line commands one at a time; `docker compose` can swallow the next line.
