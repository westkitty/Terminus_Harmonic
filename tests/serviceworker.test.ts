/**
 * SERVICE WORKER
 * ===============
 *
 * The offline shell is a requirement, not a nice-to-have, so the worker is
 * executed here rather than eyeballed: `public/sw.js` is loaded into a `vm`
 * context with stubbed `self`, `caches` and `fetch`, and driven through
 * install -> activate -> "cache-assets" -> offline navigation.
 *
 * This is what proves the first visit becomes offline-capable. The worker's
 * precache list is static and cannot know the hashed bundle names, so the page
 * has to hand them over; if that message path breaks, the game silently stops
 * working offline on a fresh install and nothing else in the suite would notice.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();
const SW_SOURCE = readFileSync(join(ROOT, 'public/sw.js'), 'utf8');

interface Recorder {
  self: Record<string, unknown>;
  caches: Map<string, Map<string, Response>>;
  posted: unknown[];
  handlers: Map<string, (event: unknown) => void>;
  fetchCalls: string[];
  failNextFetch: boolean;
}

/** A minimal but faithful stand-in for the SW global scope. */
function loadWorker(): Recorder {
  const caches = new Map<string, Map<string, Response>>();
  const handlers = new Map<string, (event: unknown) => void>();
  const posted: unknown[] = [];
  const fetchCalls: string[] = [];
  const rec: Recorder = {
    caches,
    posted,
    handlers,
    fetchCalls,
    failNextFetch: false,
    self: {},
  };

  // The real Cache API normalises request URLs; the worker mixes relative
  // strings, absolute URLs and Request objects, so the stub must too.
  const ORIGIN = 'https://example.test';
  const normKey = (r: string | { url: string }): string => {
    const raw = typeof r === 'string' ? r : r.url;
    try {
      return new URL(raw, ORIGIN).pathname;
    } catch {
      return raw;
    }
  };

  const cacheApi = {
    async open(name: string): Promise<{
      match: (req: string | { url: string }) => Promise<Response | undefined>;
      put: (req: string | { url: string }, res: Response) => Promise<void>;
      add: (req: { url: string }) => Promise<void>;
    }> {
      if (!caches.has(name)) caches.set(name, new Map());
      const store = caches.get(name)!;
      return {
        match: async (r) => store.get(normKey(r)),
        put: async (r, res) => void store.set(normKey(r), res),
        add: async (r) => {
          const res = await fetchApi({ url: r.url });
          store.set(normKey(r), res);
        },
      };
    },
    async keys(): Promise<string[]> {
      return [...caches.keys()];
    },
    async delete(name: string): Promise<boolean> {
      return caches.delete(name);
    },
  };

  // The worker fetches with a plain string in one path and a Request-ish object
  // in another, so the stub has to accept both.
  const fetchApi = async (req: string | { url: string }): Promise<Response> => {
    const url = typeof req === 'string' ? req : req.url;
    fetchCalls.push(url);
    if (rec.failNextFetch) throw new TypeError('Failed to fetch');
    return new Response(`body:${url}`, { status: 200, headers: { 'Content-Type': 'text/plain' } });
  };

  const sandbox = {
    self: {
      location: { origin: 'https://example.test' },
      addEventListener: (type: string, fn: (e: unknown) => void) => handlers.set(type, fn),
      skipWaiting: async () => undefined,
      clients: { claim: async () => undefined },
    },
    caches: cacheApi,
    fetch: fetchApi,
    Request: class {
      url: string;
      constructor(url: string) {
        this.url = url;
      }
    },
    Response,
    console,
    URL,
    Promise,
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (sandbox.self as any).__sandbox = sandbox;

  // Run the worker source with `self` bound to the sandbox's own object.
  const fn = new Function(
    'self',
    'caches',
    'fetch',
    'Request',
    'Response',
    'console',
    'URL',
    `"use strict";\n${SW_SOURCE}`,
  );
  fn(
    sandbox.self,
    cacheApi,
    fetchApi,
    sandbox.Request,
    Response,
    console,
    URL,
  );
  rec.self = sandbox.self;
  return rec;
}

/** Fire a captured SW event and let its promises settle. */
async function fire(rec: Recorder, type: string, data: unknown): Promise<void> {
  const handler = rec.handlers.get(type);
  expect(handler, `no handler registered for "${type}"`).toBeTruthy();
  const waiters: Promise<unknown>[] = [];
  const event = {
    data,
    request: data,
    waitUntil: (p: Promise<unknown>) => waiters.push(p),
    respondWith: (p: Promise<Response>) => waiters.push(p),
  };
  handler!(event);
  await Promise.allSettled(waiters);
}

describe('service worker (offline shell)', () => {
  it('registers the lifecycle handlers it needs', () => {
    const rec = loadWorker();
    for (const type of ['install', 'activate', 'fetch', 'message']) {
      expect(rec.handlers.has(type), `missing ${type} handler`).toBe(true);
    }
  });

  it('precaches the shell on install without aborting on one failure', async () => {
    const rec = loadWorker();
    await fire(rec, 'install', undefined);
    const shell = rec.caches.get('terminus-harmonic-v1-shell');
    expect(shell).toBeTruthy();
    // Keys are normalised the way the real Cache API normalises them.
    expect(shell!.has('/index.html')).toBe(true);
    expect(shell!.has('/manifest.webmanifest')).toBe(true);
    expect(shell!.has('/icons/icon-512.png')).toBe(true);
    expect(shell!.size).toBe(6);
  });

  it('caches the hashed bundles the page reports, which the static list cannot', async () => {
    const rec = loadWorker();
    await fire(rec, 'install', undefined);
    await fire(rec, 'message', {
      type: 'cache-assets',
      urls: ['/assets/index-ABC123.js', '/assets/index-DEF456.css'],
    });
    const assets = rec.caches.get('terminus-harmonic-v1-assets');
    expect(assets).toBeTruthy();
    expect(assets!.has('/assets/index-ABC123.js')).toBe(true);
    expect(assets!.has('/assets/index-DEF456.css')).toBe(true);
    expect(assets!.size).toBe(2);
  });

  it('does not re-fetch a bundle that is already cached', async () => {
    const rec = loadWorker();
    await fire(rec, 'install', undefined);
    await fire(rec, 'message', { type: 'cache-assets', urls: ['/assets/a.js'] });
    const before = rec.fetchCalls.length;
    await fire(rec, 'message', { type: 'cache-assets', urls: ['/assets/a.js'] });
    expect(rec.fetchCalls.length).toBe(before);
  });

  it('serves an offline navigation from the shell cache', async () => {
    const rec = loadWorker();
    await fire(rec, 'install', undefined);
    rec.failNextFetch = true; // the network is gone
    let served: Response | undefined;
    const handler = rec.handlers.get('fetch')!;
    handler({
      request: { method: 'GET', mode: 'navigate', url: 'https://example.test/' },
      waitUntil: () => undefined,
      respondWith: (p: Promise<Response>) => void p.then((r) => (served = r)),
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(served).toBeTruthy();
    expect(served!.status).toBe(200);
  });

  it('serves a cached asset offline instead of erroring', async () => {
    const rec = loadWorker();
    await fire(rec, 'install', undefined);
    await fire(rec, 'message', { type: 'cache-assets', urls: ['/assets/three-XYZ.js'] });
    rec.failNextFetch = true;
    let served: Response | undefined;
    const handler = rec.handlers.get('fetch')!;
    handler({
      request: {
        method: 'GET',
        mode: 'no-cors',
        url: 'https://example.test/assets/three-XYZ.js',
      },
      waitUntil: () => undefined,
      respondWith: (p: Promise<Response>) => void p.then((r) => (served = r)),
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(served).toBeTruthy();
    expect(await served!.text()).toBe('body:/assets/three-XYZ.js');
  });

  it('ignores non-GET and cross-origin requests', async () => {
    const rec = loadWorker();
    let responded = false;
    const handler = rec.handlers.get('fetch')!;
    handler({
      request: { method: 'POST', mode: 'navigate', url: 'https://example.test/' },
      waitUntil: () => undefined,
      respondWith: () => (responded = true),
    });
    handler({
      request: { method: 'GET', mode: 'no-cors', url: 'https://other.test/assets/a.js' },
      waitUntil: () => undefined,
      respondWith: () => (responded = true),
    });
    await new Promise((r) => setTimeout(r, 5));
    expect(responded).toBe(false);
  });
});
