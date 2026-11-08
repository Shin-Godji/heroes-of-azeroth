// bundles.js - the asset-bundle layer for static hosts (GitHub Pages): the full game's data as a few hundred gzip bundles,
// fetched when the game needs them instead of thousands of individual requests.
//
// tools/hoa-bundle/pack.js writes bundles.json (groups, their triggers, the bundles) and bundles-index.json (file -> bundle).
// This module answers every data request the game makes (window.__hoa_read/__hoa_has from the wasm, plus XHR and fetch
// shims for any other caller) from the bundles it holds. Groups load on triggers:
//   boot (blocking, before the game starts) | ready (first loading screen cleared) | race:<id> | zone:<id> | zone-next:<id>
//   (lower priority) | race:* / zone:* (any) | demand (only when the game asks for one of its files).
// A file whose bundle is not in yet loads that bundle at once (synchronously for the wasm's synchronous reads), so a bad
// prediction costs time, never a missing asset. A file in no bundle goes to the network as an individual file, as before.
// Bundles are kept in Cache Storage under content-hashed names (a repeat visit downloads nothing); leaving a zone drops its
// decoded bundles from memory (they come back from the cache if needed). Off with ?bundles=0, or without "bundles" in config.json.
const CACHE = 'hoa-bundles';

export async function setupBundles({ manifestUrl, dataBase, onProgress }) {
  let manifest, index;
  try {
    const [m, i] = await Promise.all([
      fetch(manifestUrl, { cache: 'no-cache' }),
      fetch(new URL('bundles-index.json', manifestUrl).href, { cache: 'no-cache' }),
    ]);
    if (!m.ok || !i.ok) return null;
    [manifest, index] = await Promise.all([m.json(), i.json()]);
  } catch (_) {
    return null;
  }
  if (!manifest || !Array.isArray(manifest.bundles) || !manifest.bundles.length) return null;
  // The synchronous fallback needs a synchronous gunzip (DecompressionStream is async only).
  try { await import('./vendor/pako_inflate.min.js'); } catch (_) {}

  const base = dataBase.replace(/[/]+$/, '');
  const B = manifest.bundles.map((b, n) => ({ ...b, n, url: new URL(b.url, manifestUrl).href, state: 0, keys: null, promise: null }));
  const store = new Map(); // key -> Uint8Array view into a decoded bundle
  const stats = { loaded: 0, fromCache: 0, demandSync: 0, demandAsync: 0, failed: 0, served: 0, missed: 0, evicted: 0, bytesNet: 0, bytesRaw: 0, signals: [] };
  const api = (window.__hoa_bundles = { store, stats, signal: () => {}, ready: () => {} });

  const keyOf = (url) => {
    if (typeof url !== 'string' || !url.startsWith(base + '/')) return null;
    let k = url.slice(base.length + 1).split(/[?#]/)[0];
    try { k = decodeURIComponent(k); } catch (_) { return null; }
    return k.toLowerCase();
  };
  const register = (b, out) => {
    const hl = new DataView(out.buffer, out.byteOffset).getUint32(0, true);
    const header = JSON.parse(new TextDecoder().decode(out.subarray(4, 4 + hl)));
    const d0 = 4 + hl;
    b.keys = [];
    for (const [key, off, len] of header.files) { store.set(key, out.subarray(d0 + off, d0 + off + len)); b.keys.push(key); }
    b.state = 2; stats.loaded++; stats.bytesRaw += out.length;
  };

  let cache = null;
  try { if (self.caches) cache = await caches.open(CACHE); } catch (_) {}
  const XP = XMLHttpRequest.prototype;
  const xOpen = XP.open, xSend = XP.send;
  const fetchReal = window.fetch.bind(window);

  // async load (the normal path)
  function load(b, onBytes) {
    if (b.state === 2) return Promise.resolve();
    if (b.promise) return b.promise;
    b.state = 1;
    b.promise = (async () => {
      try {
        let resp = null;
        if (cache) { try { resp = await cache.match(b.url); } catch (_) {} }
        if (resp) stats.fromCache++;
        else {
          resp = await fetchReal(b.url);
          if (!resp.ok || !resp.body) throw new Error('HTTP ' + resp.status);
          stats.bytesNet += b.gz;
          if (cache) cache.put(b.url, resp.clone()).catch(() => {});
        }
        if (b.state === 2) return; // a synchronous demand load got there first
        const decoded = (resp.headers.get('content-encoding') || '').trim() !== '';
        const stream = decoded ? resp.body : resp.body.pipeThrough(new DecompressionStream('gzip'));
        const out = new Uint8Array(b.raw);
        let o = 0;
        const rd = stream.getReader();
        for (;;) { const { done, value } = await rd.read(); if (done) break; out.set(value, o); o += value.length; onBytes && onBytes(value.length); }
        if (o !== b.raw) throw new Error(`size ${o} != ${b.raw}`);
        if (b.state !== 2) register(b, out);
      } catch (e) {
        if (b.state !== 2) { b.state = 3; stats.failed++; }
        console.warn('bundle failed, its files will be fetched individually:', b.url, e && e.message ? e.message : e);
      } finally {
        b.promise = null;
      }
    })();
    return b.promise;
  }

  // synchronous load, for a synchronous read of a file whose bundle is not in yet
  function loadSync(b) {
    if (b.state === 2) return true;
    if (b.state === 3 || !self.pako) return false;
    try {
      const x = new XMLHttpRequest();
      xOpen.call(x, 'GET', b.url, false);
      x.overrideMimeType('text/plain; charset=x-user-defined');
      xSend.call(x);
      if (x.status !== 200) return false;
      const t = x.responseText; const gz = new Uint8Array(t.length);
      for (let i = 0; i < t.length; i++) gz[i] = t.charCodeAt(i) & 0xff;
      stats.bytesNet += gz.length;
      register(b, self.pako.inflate(gz));
      stats.demandSync++;
      console.info('bundle loaded on demand (synchronous):', b.group, b.url.split('/').pop());
      return true;
    } catch (e) {
      console.warn('on-demand bundle failed:', b.url, e && e.message ? e.message : e);
      return false;
    }
  }

  const find = (url, sync) => {
    const k = keyOf(url);
    if (k === null) return null;
    let hit = store.get(k);
    if (!hit) {
      const n = index[k];
      if (n !== undefined && sync && loadSync(B[n])) hit = store.get(k);
    }
    if (hit) stats.served++; else stats.missed++;
    return hit || null;
  };

  // --- the answers ---
  window.__hoa_read = (url) => find(url, true);
  window.__hoa_has = (url) => { const k = keyOf(url); return k !== null && (store.has(k) || index[k] !== undefined); };

  XP.open = function (method, url, ...rest) {
    this.__hoa = null;
    if ((method === 'GET' || method === 'HEAD') && rest[0] === false) {
      const hit = method === 'HEAD' ? (window.__hoa_has(String(url)) ? new Uint8Array(0) : null) : find(String(url), true);
      if (hit) this.__hoa = { hit, head: method === 'HEAD' };
    }
    return xOpen.call(this, method, url, ...rest);
  };
  XP.send = function (body) {
    const h = this.__hoa;
    if (!h) return xSend.call(this, body);
    let text = null;
    const u8 = h.hit;
    Object.defineProperty(this, 'responseText', {
      configurable: true,
      get() {
        if (h.head) return '';
        if (text === null) { const p = []; for (let i = 0; i < u8.length; i += 8192) p.push(String.fromCharCode.apply(null, u8.subarray(i, i + 8192))); text = p.join(''); }
        return text;
      },
    });
    for (const [k, v] of Object.entries({ status: 200, statusText: 'OK', readyState: 4, getResponseHeader: (n) => (/^content-length$/i.test(n) ? String(u8.length) : null) }))
      Object.defineProperty(this, k, { configurable: true, value: v });
  };

  window.fetch = async function (input, init) {
    try {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input && input.url;
      const method = ((init && init.method) || (input && input.method) || 'GET').toUpperCase();
      const hasRange = init && init.headers && new Headers(init.headers).has('range');
      const k = keyOf(url);
      if (k !== null && (method === 'GET' || method === 'HEAD') && !hasRange) {
        let hit = store.get(k);
        if (!hit && index[k] !== undefined) { stats.demandAsync++; { const g = B[index[k]].group, d = (stats.demandBy = stats.demandBy || {}); (d[g] = d[g] || []).length < 3 && d[g].push(k.slice(-60)); } await load(B[index[k]]); hit = store.get(k); }
        if (hit) {
          stats.served++;
          return new Response(method === 'HEAD' ? null : hit.slice().buffer, { status: 200, headers: { 'content-type': 'application/octet-stream', 'content-length': String(hit.length) } });
        }
      }
    } catch (_) {}
    return fetchReal(input, init);
  };

  // --- triggers ---
  const queue = []; let running = 0; const MAX = 4;
  const pump = () => {
    while (running < MAX && queue.length) {
      queue.sort((a, b) => a.prio - b.prio);
      const { b } = queue.shift();
      if (b.state === 2 || b.state === 1) continue;
      running++;
      load(b).finally(() => { running--; pump(); });
    }
  };
  const enqueue = (g, prio) => { for (const n of g.bundles) { const b = B[n]; if (b.state === 0) queue.push({ b, prio }); } pump(); };
  let zoneNow = null, zoneNext = null;
  const matches = (list, stage) => (list || []).some((t) => t === stage || (t.endsWith(':*') && stage.startsWith(t.slice(0, -1))));
  function signal(stage) {
    stats.signals.push(stage);
    if (stage.startsWith('zone:')) zoneNow = stage.slice(5);
    if (stage.startsWith('zone-next:')) zoneNext = stage.slice(10);
    for (const g of manifest.groups) {
      if (matches(g.on, stage)) enqueue(g, g.prio);
      else if (matches(g.next, stage)) enqueue(g, g.prio + 5);
    }
    if (stage.startsWith('zone:')) evict();
  }
  // Leaving a zone: drop the decoded data of zone bundles no longer current or next (they return from Cache Storage if asked for).
  function evict() {
    for (const g of manifest.groups) {
      if (!/^(zone-|shared-)/.test(g.id)) continue;
      const zs = g.id.replace(/~$/, '').replace(/^zone-|^shared-/, '').split('+');
      if (zs.includes(zoneNow) || zs.includes(zoneNext)) continue;
      for (const n of g.bundles) { const b = B[n]; if (b.state !== 2) continue; for (const k of b.keys) store.delete(k); b.keys = null; b.state = 0; stats.evicted++; }
    }
  }
  api.signal = signal;
  // Resident decoded bytes per group (MB), for memory work: what the page holds right now.
  Object.defineProperty(stats, "resident", { enumerable: true, get() { const r = {}; for (const b of B) if (b.state === 2) r[b.group] = (r[b.group] || 0) + b.raw / 1048576; for (const k in r) r[k] = Math.round(r[k]); return r; } });

  // --- start: the blocking groups now; "ready" groups when the first loading screen clears (or 45 s) ---
  const t0 = performance.now();
  const blockingGroups = manifest.groups.filter((g) => matches(g.on, 'boot'));
  const totalBlocking = blockingGroups.reduce((a, g) => a + g.bundles.reduce((s, n) => s + B[n].raw, 0), 0);
  let doneBlocking = 0;
  const blocking = Promise.all(blockingGroups.flatMap((g) => g.bundles.map((n) => load(B[n], (k) => { doneBlocking += k; onProgress && onProgress(doneBlocking, totalBlocking); })))).then(() => { stats.blockingMs = Math.round(performance.now() - t0); });
  let readyDone = false;
  const ready = () => { if (!readyDone) { readyDone = true; signal('ready'); } };
  api.ready = ready;
  setTimeout(ready, 45000);
  const background = blocking.then(() => {
    if (cache) { // drop bundles of older builds
      const keep = new Set(B.map((b) => b.url));
      cache.keys().then(async (ks) => { for (const k of ks) if (!keep.has(k.url)) await cache.delete(k); }).catch(() => {});
    }
  });
  return { blocking, background, stats, ready, signal };
}
