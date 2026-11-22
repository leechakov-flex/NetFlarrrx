// Discover, served fast: built on a worker thread, cached a few minutes per filter,
// and while a fresh copy is being built the last one is served (stale-while-revalidate).
import { Worker } from 'node:worker_threads';
import type { Config } from '../config.js';
import type { Db } from '../db/db.js';
import type { HomeResponse } from '../api/types.js';
import type { ServiceKey } from '../services.js';
import { companies, home, type CompanyPick } from './queries.js';
import type { CompaniesResponse } from '../api/types.js';
import { enabledServices } from '../services.js';
import { log } from '../log.js';

const FRESH_MS = 3 * 60_000;      // younger than this: serve as is
const KEEP_MS = 60 * 60_000;      // older than FRESH but younger than this: serve, and rebuild behind it

export class HomeService {
  private cache = new Map<string, { at: number; value: HomeResponse }>();
  private inflight = new Map<string, Promise<HomeResponse>>();
  private worker: Worker | null = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private companiesCache: { at: number; value: CompaniesResponse } | null = null;
  private companiesInflight: Promise<CompaniesResponse> | null = null;
  private seq = 0;

  constructor(private db: Db, private cfg: Config) {
    // A worker needs the built .js files and a database file (tests use an in-memory one).
    if (cfg.DATA_DIR !== ':memory:' && import.meta.url.endsWith('.js')) {
      try { this.startWorker(); } catch (err) { log.warn('home: no worker, building Discover inline', { error: (err as Error).message }); }
    }
  }

  private startWorker() {
    const w = new Worker(new URL('./homeWorker.js', import.meta.url), { workerData: { cfg: this.cfg } });
    w.on('message', (m: { id: number; value?: HomeResponse; error?: string }) => {
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      if (m.error) p.reject(new Error(m.error)); else p.resolve(m.value!);
    });
    w.on('error', (err: Error) => { log.error('home: worker failed', { error: err.message }); });
    w.on('exit', () => {
      for (const p of this.pending.values()) p.reject(new Error('Discover worker stopped'));
      this.pending.clear();
      this.worker = null;
    });
    w.unref();
    this.worker = w;
  }

  private run<T>(job: 'home' | 'companies', only: ServiceKey[], co: CompanyPick, inline: () => T): Promise<T> {
    if (!this.worker && this.cfg.DATA_DIR !== ':memory:' && import.meta.url.endsWith('.js')) {
      try { this.startWorker(); } catch { /* inline below */ }
    }
    if (!this.worker) return Promise.resolve(inline());
    const id = ++this.seq;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker!.postMessage({ id, job, now: new Date().toISOString(), only, co });
    });
  }

  private build(only: ServiceKey[], co: CompanyPick): Promise<HomeResponse> {
    return this.run('home', only, co, () => home(this.db, this.cfg, new Date(), only, co));
  }

  /** Studios and networks for the picker: built on the worker too, cached 10 minutes. */
  async companies(): Promise<CompaniesResponse> {
    if (this.cfg.DATA_DIR === ':memory:') return companies(this.db, this.cfg);
    const c = this.companiesCache;
    if (c && Date.now() - c.at < 10 * 60_000) return c.value;
    this.companiesInflight ??= this.run('companies', [], {}, () => companies(this.db, this.cfg))
      .then((value) => { this.companiesCache = { at: Date.now(), value }; return value; })
      .finally(() => { this.companiesInflight = null; });
    // A stale list is fine while the new one builds.
    return c ? c.value : this.companiesInflight;
  }

  private refresh(key: string, only: ServiceKey[], co: CompanyPick): Promise<HomeResponse> {
    let p = this.inflight.get(key);
    if (!p) {
      const started = Date.now();
      p = this.build(only, co)
        .then((value) => {
          this.cache.set(key, { at: Date.now(), value });
          if (Date.now() - started > 2000) log.info('home: built Discover', { key: key || 'all', ms: Date.now() - started });
          return value;
        })
        .finally(() => this.inflight.delete(key));
      this.inflight.set(key, p);
    }
    return p;
  }

  async get(only: ServiceKey[], co: CompanyPick): Promise<HomeResponse> {
    // Tests (in-memory database) change data between calls and expect it at once: no cache.
    if (this.cfg.DATA_DIR === ':memory:') return home(this.db, this.cfg, new Date(), only, co);
    const key = JSON.stringify([only, co.studios ?? [], co.networks ?? []]);
    const hit = this.cache.get(key);
    const age = hit ? Date.now() - hit.at : Infinity;
    if (hit && age < FRESH_MS) return hit.value;
    if (hit && age < KEEP_MS) {
      void this.refresh(key, only, co).catch((err) => log.warn('home: rebuild failed', { error: (err as Error).message }));
      return hit.value;
    }
    return this.refresh(key, only, co);
  }

  /** After a sync, a request or anything else that changes Discover: rebuild on the next look. */
  invalidate() {
    const stale = Date.now() - FRESH_MS - 1;   // stale but still served while it rebuilds
    for (const [k, v] of this.cache) this.cache.set(k, { ...v, at: Math.min(v.at, stale) });
  }

  /**
   * Build Discover now, so the first look after startup or a sync is instant: the plain
   * one first, then each single-service chip (on the worker, one after another).
   */
  async warm() {
    if (this.cfg.DATA_DIR === ':memory:') return;
    const views: ServiceKey[][] = [[], ...enabledServices(this.cfg.SERVICES).map((s) => [s.key] as ServiceKey[])];
    for (const only of views) await this.refresh(JSON.stringify([only, [], []]), only, {}).catch(() => undefined);
    await this.companies().catch(() => undefined);
  }

  close() { void this.worker?.terminate(); this.worker = null; }
}
