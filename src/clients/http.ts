export type FetchFn = typeof fetch;

export class HttpError extends Error {
  constructor(
    public readonly service: string,
    public readonly status: number,
    public readonly url: string,
    public readonly body: unknown,
  ) {
    super(`${service} HTTP ${status} for ${redactUrl(url)}`);
    this.name = 'HttpError';
  }
  get isAuth() { return this.status === 401 || this.status === 403; }
  get isNotFound() { return this.status === 404; }
}

export interface RequestOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
  retries?: number;        // extra attempts for 429, 5xx and network errors
  timeoutMs?: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function requestJson<T>(
  fetchFn: FetchFn,
  service: string,
  url: string,
  opts: RequestOptions = {},
): Promise<T> {
  const retries = opts.retries ?? 3;
  let attempt = 0;
  for (;;) {
    attempt += 1;
    let res: Response;
    try {
      res = await fetchFn(url, {
        method: opts.method ?? 'GET',
        headers: { Accept: 'application/json', ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...opts.headers },
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        signal: AbortSignal.timeout(opts.timeoutMs ?? 20_000),
      });
    } catch (err) {
      if (attempt <= retries) { await sleep(backoff(attempt)); continue; }
      throw new Error(`${service} request failed for ${redactUrl(url)}: ${(err as Error).message}`);
    }
    const text = await res.text();
    let body: unknown = null;
    if (text) {
      try { body = JSON.parse(text); } catch { body = text.slice(0, 500); }
    }
    if (res.ok) return body as T;
    if ((res.status === 429 || res.status >= 500) && attempt <= retries) {
      const ra = Number(res.headers.get('retry-after'));
      await sleep(Number.isFinite(ra) && ra > 0 ? Math.min(ra * 1000, 60_000) : backoff(attempt));
      continue;
    }
    throw new HttpError(service, res.status, url, body);
  }
}

function backoff(attempt: number) {
  const base = process.env.VITEST === 'true' ? 1 : 1000;
  return base * 2 ** (attempt - 1);
}

export function redactUrl(url: string) {
  return url.replace(/([?&](api_?key|apiKey|token)=)[^&]*/gi, '$1<redacted>');
}

// Spaces calls at least `intervalMs` apart (Watchmode free plan: 120 requests/minute).
export class Throttle {
  private last = 0;
  private chain: Promise<void> = Promise.resolve();
  constructor(private intervalMs: number) {}
  wait(): Promise<void> {
    const next = this.chain.then(async () => {
      const delay = this.last + this.intervalMs - Date.now();
      if (delay > 0) await sleep(delay);
      this.last = Date.now();
    });
    this.chain = next;
    return next;
  }
}

// Runs fn over items with at most `limit` in flight.
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i] as T, i);
    }
  });
  await Promise.all(workers);
  return results;
}
