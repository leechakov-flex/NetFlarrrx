// "Season N is out": a series you have in Sonarr has a newer season that
// Sonarr isn't set to grab and you haven't requested.
const RECENT_DAYS = 90;

export interface SeasonFacts {
  haveSeason: number | null;          // highest season you have episodes of (Sonarr)
  monitoredJson: string | null;       // seasons Sonarr is set to grab
  seasons: number | null;             // TMDB season count
  lastAirDate: string | null;         // TMDB: latest episode aired
  seerrSeasonsJson: string | null;    // Seerr per-season status
}

export function newSeason(f: SeasonFacts, now = new Date()): { season: number; haveThrough: number } | null {
  if (f.haveSeason == null || !f.seasons || f.seasons <= f.haveSeason) return null;
  if (!f.lastAirDate || now.getTime() - Date.parse(f.lastAirDate) > RECENT_DAYS * 86_400_000) return null;
  const latest = f.seasons;
  const monitored: number[] = f.monitoredJson ? JSON.parse(f.monitoredJson) : [];
  if (monitored.includes(latest)) return null;                  // Sonarr will get it
  const seerr: { seasonNumber: number; status: number }[] = f.seerrSeasonsJson ? JSON.parse(f.seerrSeasonsJson) : [];
  if (seerr.some((s) => s.seasonNumber === latest && s.status > 1)) return null;   // requested, processing or available
  return { season: latest, haveThrough: f.haveSeason };
}

/** SQL for the series that might qualify; `newSeason` makes the final call. */
export const NEW_SEASON_CANDIDATES = `
  JOIN library_items li ON li.media_type = 'tv' AND li.tmdb_id = tk.tmdb_id
  WHERE tk.tmdb_type = 'tv' AND li.have_season IS NOT NULL AND tk.seasons > li.have_season AND tk.last_air_date >= ?`;
export const newSeasonSince = (now: Date) => new Date(now.getTime() - RECENT_DAYS * 86_400_000).toISOString().slice(0, 10);
