import { describe, it, expect } from 'vitest';
import { pickTrailer, type TmdbVideo } from './tmdb.js';

const v = (over: Partial<TmdbVideo>): TmdbVideo => ({
  key: 'k', site: 'YouTube', type: 'Trailer', name: '', official: false, iso_639_1: 'en', published_at: null, ...over,
});

describe('pickTrailer', () => {
  it('prefers an official English trailer over teasers and unofficial ones', () => {
    expect(pickTrailer([
      v({ key: 'teaser', type: 'Teaser', official: true }),
      v({ key: 'fan', official: false }),
      v({ key: 'official', official: true }),
    ])?.key).toBe('official');
  });

  it('falls back to a teaser when there is no trailer', () => {
    expect(pickTrailer([v({ key: 'clip', type: 'Clip' }), v({ key: 'teaser', type: 'Teaser' })])?.key).toBe('teaser');
  });

  it('ignores non-YouTube videos and featurettes', () => {
    expect(pickTrailer([v({ key: 'vimeo', site: 'Vimeo' }), v({ key: 'bts', type: 'Behind the Scenes' })])).toBeNull();
  });

  it('prefers English over another language at the same rank, then the newest', () => {
    expect(pickTrailer([
      v({ key: 'es', iso_639_1: 'es', official: true }),
      v({ key: 'en-old', official: true, published_at: '2020-01-01' }),
      v({ key: 'en-new', official: true, published_at: '2024-01-01' }),
    ])?.key).toBe('en-new');
  });

  it('returns null for no videos', () => {
    expect(pickTrailer([])).toBeNull();
  });
});
