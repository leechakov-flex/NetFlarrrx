// Ordered, append-only. Never edit a shipped migration; add a new one.
// Timestamps are ISO-8601 UTC strings.
export const migrations: { version: number; name: string; sql: string }[] = [
  {
    version: 1,
    name: 'initial',
    sql: `
CREATE TABLE titles (
  id              INTEGER PRIMARY KEY,
  watchmode_id    INTEGER NOT NULL UNIQUE,
  title           TEXT NOT NULL,
  year            INTEGER,
  watchmode_type  TEXT NOT NULL,            -- raw: movie, tv_series, tv_miniseries, tv_special, tv_movie, short_film
  imdb_id         TEXT,
  tmdb_id         INTEGER,
  tmdb_type       TEXT CHECK (tmdb_type IN ('movie', 'tv')),
  tmdb_status     TEXT NOT NULL DEFAULT 'pending'
                  CHECK (tmdb_status IN ('pending', 'ok', 'missing', 'no_tmdb_id', 'error')),
  tmdb_fetched_at TEXT,
  tmdb_error      TEXT,
  tmdb_title      TEXT,
  original_language TEXT,
  overview        TEXT,
  poster_path     TEXT,
  backdrop_path   TEXT,
  release_date    TEXT,
  vote_average    REAL,
  vote_count      INTEGER,
  popularity      REAL,
  runtime         INTEGER,                  -- minutes (movies)
  seasons         INTEGER,                  -- season count (series)
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
-- Not unique: Watchmode can map two of its entries to one TMDB record.
CREATE INDEX titles_tmdb ON titles (tmdb_type, tmdb_id);
CREATE INDEX titles_tmdb_status ON titles (tmdb_status, tmdb_fetched_at);

CREATE TABLE genres (
  id   INTEGER PRIMARY KEY,                 -- TMDB genre id
  name TEXT NOT NULL
);
CREATE TABLE title_genres (
  title_id INTEGER NOT NULL REFERENCES titles (id) ON DELETE CASCADE,
  genre_id INTEGER NOT NULL REFERENCES genres (id),
  PRIMARY KEY (title_id, genre_id)
);
CREATE INDEX title_genres_genre ON title_genres (genre_id);

CREATE TABLE keywords (
  id   INTEGER PRIMARY KEY,                 -- TMDB keyword id
  name TEXT NOT NULL
);
CREATE TABLE title_keywords (
  title_id   INTEGER NOT NULL REFERENCES titles (id) ON DELETE CASCADE,
  keyword_id INTEGER NOT NULL REFERENCES keywords (id),
  PRIMARY KEY (title_id, keyword_id)
);
CREATE INDEX title_keywords_keyword ON title_keywords (keyword_id);

-- One row per title per provider per region. This is the irreplaceable history.
CREATE TABLE availability (
  id              INTEGER PRIMARY KEY,
  title_id        INTEGER NOT NULL REFERENCES titles (id) ON DELETE CASCADE,
  provider_id     INTEGER NOT NULL,         -- Watchmode source id (203 = Netflix)
  region          TEXT NOT NULL,
  first_seen_at   TEXT NOT NULL,            -- first observation ever; never changes
  added_at        TEXT,                     -- shown as "date added"; NULL for baseline titles
  last_seen_at    TEXT NOT NULL,
  missing_count   INTEGER NOT NULL DEFAULT 0,
  missing_since   TEXT,                     -- first complete sync that missed it
  removed_at      TEXT,                     -- set once missing_count reaches the threshold
  baseline        INTEGER NOT NULL DEFAULT 0,
  back_on_service INTEGER NOT NULL DEFAULT 0, -- returned after the return window
  UNIQUE (title_id, provider_id, region)
);
CREATE INDEX availability_added ON availability (provider_id, region, removed_at, added_at);

CREATE TABLE sync_runs (
  id             INTEGER PRIMARY KEY,
  provider_id    INTEGER NOT NULL,
  region         TEXT NOT NULL,
  trigger        TEXT NOT NULL,             -- schedule | manual | cli
  status         TEXT NOT NULL CHECK (status IN ('running', 'complete', 'partial', 'held', 'failed', 'skipped')),
  applied        INTEGER NOT NULL DEFAULT 0, -- diff written to availability
  baseline       INTEGER NOT NULL DEFAULT 0,
  started_at     TEXT NOT NULL,
  finished_at    TEXT,
  confirmed_at   TEXT,                      -- a held run released by hand
  pages_total    INTEGER,
  pages_fetched  INTEGER,
  failed_pages   TEXT,                      -- JSON array
  titles_seen    INTEGER,
  previous_count INTEGER,
  added          INTEGER,
  returned       INTEGER,
  back_on_service INTEGER,
  missed         INTEGER,
  removed        INTEGER,
  quota          INTEGER,
  quota_used_before INTEGER,
  quota_used_after  INTEGER,
  note           TEXT
);
CREATE INDEX sync_runs_recent ON sync_runs (provider_id, region, started_at);

-- Which titles each run saw. Kept 30 days; needed to release a held run.
CREATE TABLE sync_observations (
  run_id       INTEGER NOT NULL REFERENCES sync_runs (id) ON DELETE CASCADE,
  watchmode_id INTEGER NOT NULL,
  PRIMARY KEY (run_id, watchmode_id)
) WITHOUT ROWID;

-- Mirror of Seerr's /api/v1/media list.
CREATE TABLE seerr_media (
  media_type   TEXT NOT NULL CHECK (media_type IN ('movie', 'tv')),
  tmdb_id      INTEGER NOT NULL,
  seerr_id     INTEGER NOT NULL,
  status       INTEGER NOT NULL,            -- 1 unknown, 2 pending, 3 processing, 4 partial, 5 available, 6 blocklisted, 7 deleted
  status4k     INTEGER,
  seasons_json TEXT,                        -- [{"seasonNumber":1,"status":5}, ...]
  updated_at   TEXT,                        -- Seerr's own timestamp
  mirrored_at  TEXT NOT NULL,
  PRIMARY KEY (media_type, tmdb_id)
);

CREATE TABLE job_state (
  key        TEXT PRIMARY KEY,
  value      TEXT,
  updated_at TEXT NOT NULL
);

-- Thematic rows (M4). Rule is JSON validated by the app.
CREATE TABLE rows (
  id         INTEGER PRIMARY KEY,
  slug       TEXT NOT NULL UNIQUE,
  name       TEXT NOT NULL,
  rule_json  TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  enabled    INTEGER NOT NULL DEFAULT 1
);

-- Watchmode type -> the two kinds the app shows. tv_special and unknown types are excluded.
CREATE VIEW title_kinds AS
SELECT t.*,
  CASE t.watchmode_type
    WHEN 'movie' THEN 'movie' WHEN 'tv_movie' THEN 'movie' WHEN 'short_film' THEN 'movie'
    WHEN 'tv_series' THEN 'series' WHEN 'tv_miniseries' THEN 'series'
    ELSE NULL
  END AS kind
FROM titles t;
`,
  },
  {
    version: 2,
    name: 'trailers_and_certification',
    sql: `
ALTER TABLE titles ADD COLUMN trailer_key TEXT;      -- YouTube video id
ALTER TABLE titles ADD COLUMN trailer_name TEXT;
ALTER TABLE titles ADD COLUMN certification TEXT;    -- US rating, e.g. PG-13, TV-MA

-- Views select t.*, so rebuild it to pick up the new columns.
DROP VIEW title_kinds;
CREATE VIEW title_kinds AS
SELECT t.*,
  CASE t.watchmode_type
    WHEN 'movie' THEN 'movie' WHEN 'tv_movie' THEN 'movie' WHEN 'short_film' THEN 'movie'
    WHEN 'tv_series' THEN 'series' WHEN 'tv_miniseries' THEN 'series'
    ELSE NULL
  END AS kind
FROM titles t;

-- Re-fetch everything once so existing titles get trailers and ratings.
UPDATE titles SET tmdb_status = 'pending' WHERE tmdb_status IN ('ok', 'missing');
`,
  },
  {
    version: 3,
    name: 'specials_originals_library',
    sql: `
ALTER TABLE titles ADD COLUMN last_air_date TEXT;                           -- series: latest episode aired
ALTER TABLE titles ADD COLUMN netflix_original INTEGER NOT NULL DEFAULT 0;  -- TMDB network or studio is Netflix

-- Watchmode files stand-up and other specials as tv_special; TMDB has them as
-- movies, so the app shows them as movies.
DROP VIEW title_kinds;
CREATE VIEW title_kinds AS
SELECT t.*,
  CASE t.watchmode_type
    WHEN 'movie' THEN 'movie' WHEN 'tv_movie' THEN 'movie' WHEN 'short_film' THEN 'movie' WHEN 'tv_special' THEN 'movie'
    WHEN 'tv_series' THEN 'series' WHEN 'tv_miniseries' THEN 'series'
    ELSE NULL
  END AS kind
FROM titles t;

-- Your library (what Seerr shows as available), with TMDB's recommendations
-- for each title, for "Recommended for you".
CREATE TABLE library_items (
  media_type  TEXT NOT NULL CHECK (media_type IN ('movie', 'tv')),
  tmdb_id     INTEGER NOT NULL,
  title       TEXT,
  added_at    TEXT,                 -- when it became available (Seerr's timestamp)
  recs_at     TEXT,                 -- when recommendations were last fetched
  recs_status TEXT,                 -- ok, missing, error
  PRIMARY KEY (media_type, tmdb_id)
);
CREATE TABLE library_recs (
  seed_type TEXT NOT NULL,
  seed_id   INTEGER NOT NULL,
  rec_type  TEXT NOT NULL,
  rec_id    INTEGER NOT NULL,
  rank      INTEGER NOT NULL,       -- 1 = TMDB's strongest recommendation
  PRIMARY KEY (seed_type, seed_id, rec_type, rec_id),
  FOREIGN KEY (seed_type, seed_id) REFERENCES library_items (media_type, tmdb_id) ON DELETE CASCADE
);
CREATE INDEX library_recs_rec ON library_recs (rec_type, rec_id);

-- Re-fetch everything once for new-season dates and the Netflix-original flag.
UPDATE titles SET tmdb_status = 'pending' WHERE tmdb_status IN ('ok', 'missing');
`,
  },
  {
    version: 4,
    name: 'library_sources',
    sql: `
ALTER TABLE library_items ADD COLUMN source TEXT;   -- radarr, sonarr or seerr (first that has it)
`,
  },
  {
    version: 5,
    name: 'library_categories',
    sql: `
ALTER TABLE library_items ADD COLUMN category TEXT;   -- standup, movie or series, for mixing "Because you have" rows
UPDATE library_items SET recs_at = NULL;              -- re-fetch once to learn each title's category
`,
  },
  {
    version: 6,
    name: 'library_categories_again',
    sql: `UPDATE library_items SET recs_at = NULL;   -- re-sort library titles with the wider stand-up check`,
  },
];
