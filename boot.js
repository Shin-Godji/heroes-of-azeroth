// boot.js — the pre-login loading experience, shared by the dev page (web/index.html) and the
// realm page (crates/wenilla-realm/templates/play.html).
//
// Why this exists: the client cannot show its own boot. Everything a fresh tab waits on — the
// 15 MB (brotli) wasm download, instantiation, and the first update's catalog pile (~100+
// synchronous XHR chain reads in ONE rAF task, the "unresponsive tab" window) — happens before
// the first frame the app could draw. So the page owns a DOM overlay, and it does two jobs:
//
//   1. SHOW what is happening: a byte-counted wasm download bar (the counting stream is
//      re-wrapped in a Response so `WebAssembly.compileStreaming` still streams), a
//      "game data N/M" line for the prefetch, then indeterminate "Starting…" states driven by
//      the client's own `window.__wenilla_progress(stage)` calls (benilla-app/src/webprogress.rs)
//      until "ready" — the first glue screen — fades the overlay out.
//   2. SHRINK the unresponsive window: `/data/*` is served immutable (max-age=1y), and a sync
//      XHR is served from the HTTP cache when the same URL was fetch()ed first (verified live:
//      transferSize 0, deliveryType "cache"). So the overlay prefetches the boot read-set — a
//      checked-in manifest (boot-manifest.json) captured from a traced boot — with a small
//      fetch pool, in parallel with the wasm download. The catalog pile then costs parse, not
//      ~100 serial network round trips. Every miss (drift, missing manifest) degrades to
//      exactly today's behavior, and a warm-cache visitor flies through all of it: progress is
//      measured, never scripted.
//
// Page contract: `const w = await boot(init); bind(w.memory);` — bind must stay immediately
// after (the Lua WASI shims need the module's linear memory). Query switches: `?boottrace=1`
// arms window.__wenilla_boottrace and skips the prefetch (a manifest-capture boot must show the
// true read order); `?noprefetch=1` skips the prefetch only (the A/B lever).

// The wasm travels brotli-compressed: content-length counts .br bytes while the counted stream
// yields decompressed ones. Dividing the two on a real build gives ~5.0; it drifts a little per
// build and that is cosmetic — the bar is clamped at 99% until the stream actually ends.
const BR_RATIO = 5.0;
const GZ_RATIO = 3.7; // 80 MB wasm / 21.9 MB gzip
const READY_TIMEOUT_MS = 20000;
const PREFETCH_CONCURRENCY = 8;
const WASM_CACHE = 'hoa-wasm';

// Where this deployment's files live. Defaults serve the dev page from its own origin; a hosting
// page puts a config.json beside index.html (never cached long: it names the current build):
//   { "build": "<content hash>", "wasm": "<url of that build's wasm>",
//     "data": "<url of the data folder, no trailing slash>", "report": "<feedback form url>" }
// The wasm and data URLs may be on another origin (a CDN bucket, with CORS for GET and HEAD).
let WASM_URL = new URL('./wenilla_bg.wasm', import.meta.url).href;
let DATA_BASE = '/data';

async function applyConfig() {
  let cfg = {};
  try {
    const r = await fetch('./config.json', { cache: 'no-cache' });
    if (r.ok) cfg = await r.json();
  } catch (_) {
    /* no config.json: the defaults above are the dev-server layout */
  }
  const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : '');
  if (str(cfg.wasm)) WASM_URL = new URL(str(cfg.wasm), location.href).href;
  // Relative values resolve against the page (a project site lives under /<repo>/, not at the origin root).
  if (str(cfg.data)) DATA_BASE = new URL(str(cfg.data), location.href).href.replace(/[/]+$/, '');
  // The Rust side reads these once at start (benilla_formats::web::data_base, webenv).
  if (DATA_BASE !== '/data') window.__wenilla_data_base = DATA_BASE;
  const env = (window.__wenilla_env = window.__wenilla_env || {});
  if (str(cfg.build) && !env.hoa_build) env.hoa_build = str(cfg.build);
  if (str(cfg.report) && !env.hoa_report_url) env.hoa_report_url = str(cfg.report);
}

function dataUrl(name) {
  return DATA_BASE + '/' + dataPath(name);
}

export async function boot(init, opts = {}) {
  const q = new URLSearchParams(location.search);
  await applyConfig();
  const ui = createBootUi();
  if (q.get('boottrace') === '1') window.__wenilla_boottrace = [];
  const skipPrefetch = q.get('boottrace') === '1' || q.get('noprefetch') === '1';
  installProgressHook(ui, skipPrefetch);

  const prefetch = skipPrefetch
    ? Promise.resolve()
    : prefetchManifest('./boot-manifest.json', (done, total) => ui.setData(done, total)).catch(
        () => ui.setData(0, 0)
      );

  // Compile immediately: merely fetching a Response leaves its body backpressured until
  // someone consumes it. Instantiation must still wait for the cache warmup because the
  // game's Startup performs synchronous reads of the prefetched catalogs.
  const wasm = compileWasm(WASM_URL, (got, total) => ui.setWasmProgress(got, total));
  let w;
  try {
    // Attach rejection handlers to both operations now, including while prefetch is pending.
    const [module] = await Promise.all([wasm, prefetch]);
    w = await init({ module_or_path: module });
  } catch (e) {
    ui.fail('The client failed to start: ' + (e && e.message ? e.message : e));
    throw e;
  }
  // init() resolved = module instantiated and the plugin graph built; the heavy catalog frame
  // is still ahead. From here the client drives the stages; the timeout is the drift backstop
  // (an old bundle without webprogress under a new page must not strand the overlay).
  ui.setStage('Starting…');
  ui.armTimeout(opts.readyTimeoutMs ?? READY_TIMEOUT_MS);
  return w;
}

// Match wasm-bindgen's non-streaming fallback for servers without the WASM MIME type.
// Choose before consuming the body, avoiding a cloned response buffering the whole module.
async function compileWasm(url, onBytes) {
  const response = await fetchWasm(url, onBytes);
  if (!response.ok) throw new Error(`Client download failed (HTTP ${response.status})`);
  if (typeof WebAssembly.compileStreaming === 'function' &&
      response.headers.get('content-type')?.trim().toLowerCase() === 'application/wasm') {
    return WebAssembly.compileStreaming(response);
  }
  return WebAssembly.compile(await response.arrayBuffer());
}

/// Byte-counting fetch of the wasm, re-wrapped so streaming compilation survives. Returns a
/// Promise<Response> consumed immediately by compileWasm, before game instantiation.
async function fetchWasm(url, onBytes) {
  // Chrome's HTTP cache refuses entries above roughly 32-48 MB (measured: a 32 MB response is
  // cached, 48 MB never is) and the module is 80 MB, so it came down on every visit. Cache
  // Storage has no such cap and is keyed by URL: the build's content hash is in the name
  // (config.json), so a new build is a new key and an old module can never be served for it.
  const key = new URL(url, location.href).href;
  let cache = null;
  try {
    if (self.caches) cache = await caches.open(WASM_CACHE);
  } catch (_) {
    /* private mode, blocked storage: just download */
  }
  if (cache) {
    try {
      const hit = await cache.match(key);
      if (hit) {
        onBytes(1, 1);
        return hit;
      }
    } catch (_) {}
  }
  const r = await downloadWasm(url, onBytes);
  if (cache && r.ok && r.body) {
    const [forCompile, forCache] = [r, r.clone()];
    cache
      .put(key, forCache)
      .then(async () => {
        // Drop every other build's module: one 80 MB copy is all a player ever keeps.
        for (const other of await cache.keys()) if (other.url !== key) await cache.delete(other);
      })
      .catch(() => {});
    return forCompile;
  }
  return r;
}

async function downloadWasm(url, onBytes) {
  const r = await fetch(url);
  if (!r.ok || !r.body) return r; // compileWasm surfaces HTTP errors / handles a missing stream
  const contentLength = Number(r.headers.get('content-length')) || 0;
  const encoded = !!(r.headers.get('content-encoding') || '').trim();
  // `…wasm.gz` with no Content-Encoding from the host (GitHub Pages sets no headers): gunzip in the page.
  const gunzip = !encoded && /[.]wasm[.]gz(?:[?#]|$)/i.test(url) && typeof DecompressionStream === 'function';
  const compressed = encoded || gunzip;
  const total = contentLength ? contentLength * (compressed ? (gunzip ? GZ_RATIO : BR_RATIO) : 1) : 0;
  let got = 0;
  const reader = r.body.getReader();
  const counted = new ReadableStream({
    async pull(c) {
      const { done, value } = await reader.read();
      if (done) {
        onBytes(got, got); // the honest total, now that we know it
        c.close();
        return;
      }
      got += value.byteLength;
      onBytes(got, total);
      c.enqueue(value);
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
  // Headers are copied so Content-Type: application/wasm survives — compileStreaming
  // refuses anything else.
  if (gunzip) {
    return new Response(counted.pipeThrough(new DecompressionStream('gzip')), {
      status: r.status,
      statusText: r.statusText,
      headers: { 'content-type': 'application/wasm' },
    });
  }
  return new Response(counted, { status: r.status, statusText: r.statusText, headers: r.headers });
}

/// Warm the HTTP cache with a manifest's read-set: fetch the manifest, then a fixed-size pool of
/// full-body fetches. Failures are counted as done and otherwise ignored — a miss just means
/// that file loads the old way. A missing/invalid manifest resolves immediately (line hides).
/// Used twice: the boot set before `init()`, the world-entry set after `ready`.
// A chain name's path under /data: the twin of benilla_formats::web::encode_name (lowercase,
// each `\` part encodeURIComponent'd, joined by `/`), so a prefetch warms the URL the wasm asks.
function dataPath(name) {
  return name.toLowerCase().split('\\').map(encodeURIComponent).join('/');
}

async function prefetchManifest(manifestUrl, onProgress) {
  const r = await fetch(manifestUrl);
  if (!r.ok) return onProgress(0, 0);
  const manifest = await r.json();
  const names = Array.isArray(manifest && manifest.names) ? manifest.names : [];
  if (!names.length) return onProgress(0, 0);
  let done = 0;
  onProgress(0, names.length);
  const queue = names.slice();
  async function worker() {
    for (;;) {
      const name = queue.shift();
      if (name === undefined) return;
      try {
        const resp = await fetch(dataUrl(name));
        if (resp.ok) await resp.arrayBuffer(); // body fully read = body fully cached
      } catch (_) {
        /* offline blip, 404 drift — the sync XHR path will deal with it */
      }
      done += 1;
      onProgress(done, names.length);
    }
  }
  await Promise.all(Array.from({ length: PREFETCH_CONCURRENCY }, worker));
}

/// `window.__wenilla_progress(stage)` — the client's calls land here (webprogress.rs).
///
/// `ready` also starts the SECOND prefetch: the world-entry read-set. Entering the world used
/// to be one frozen frame of ~200 synchronous sprite reads (184 `Interface\…\*.blp` on the
/// first UI draw, plus a few quest-marker models and zone sounds) — 206 s on a cold 100 ms-RTT
/// cache. That set is location-independent, so `world-manifest.json` (captured the same way
/// as the boot manifest, minus the boot set) is warmed while the player is at the glue screens,
/// with a corner line so it is visible but never in the way. Whatever is still in flight when
/// they click Enter World just loads the old way.
function installProgressHook(ui, skipPrefetch) {
  let prefetching = false;
  const startWorldPrefetch = () => {
    if (skipPrefetch || prefetching) return;
    prefetching = true;
    const corner = createCornerLine();
    prefetchManifest('./world-manifest.json', (done, total) =>
      corner.set(total > 0 && done < total ? `preparing world data — ${done}/${total}` : '')
    )
      .catch(() => {})
      .finally(() => corner.remove());
  };
  window.__wenilla_progress = (stage) => {
    if (stage === 'startup') ui.setStage('Raising the world…');
    // The game's own loading screen is up: start the world read-set now, but leave the overlay.
    else if (stage === 'loading') startWorldPrefetch();
    else if (stage === 'ready') {
      ui.hide();
      startWorldPrefetch();
    }
  };
}

/// The unobtrusive bottom-left status line the world prefetch reports on.
function createCornerLine() {
  const el = document.createElement('div');
  el.id = 'wenilla-corner';
  el.style.cssText =
    'position:fixed;left:.6rem;bottom:.5rem;z-index:15;font:12px system-ui,sans-serif;' +
    'color:#888;background:rgba(0,0,0,.55);padding:.2rem .5rem;border-radius:4px;' +
    'pointer-events:none;transition:opacity .4s ease';
  document.body.appendChild(el);
  return {
    set(text) {
      el.textContent = text;
      el.style.opacity = text ? '1' : '0';
    },
    remove() {
      el.style.opacity = '0';
      setTimeout(() => el.remove(), 500);
    },
  };
}

/// The overlay itself. Same dark theme as the pages' own chrome; no dependencies, no images.
function createBootUi() {
  const root = document.createElement('div');
  root.id = 'wenilla-boot';
  root.innerHTML = `
    <style>
      @font-face { font-family: 'WowMorpheus'; src: url('${DATA_BASE}/fonts/morpheus.ttf'); font-display: swap; }
      @font-face { font-family: 'WowFriz'; src: url('${DATA_BASE}/fonts/frizqt__.ttf'); font-display: swap; }
      #wenilla-boot { position: fixed; inset: 0; z-index: 20; display: grid; place-items: center;
        color: #d8c9a3; font: 14px WowFriz, Georgia, serif; overflow: hidden;
        background:
          radial-gradient(ellipse at 50% 38%, rgba(120, 70, 20, .28), transparent 60%),
          radial-gradient(ellipse at 50% 120%, rgba(160, 30, 10, .35), transparent 55%),
          #070504;
        transition: opacity .6s ease; }
      #wenilla-boot.gone { opacity: 0; pointer-events: none; }
      #wenilla-boot::before { content: ''; position: absolute; inset: -50%;
        background: repeating-conic-gradient(from 0deg, rgba(255, 200, 90, .05) 0deg, transparent 4deg 11deg, rgba(255, 200, 90, .05) 15deg);
        filter: blur(6px); animation: wboot-spin 120s linear infinite;
        mask: radial-gradient(circle at 50% 50%, #000 0 18%, transparent 55%); }
      #wenilla-boot .embers { position: absolute; inset: 0; pointer-events: none; }
      #wenilla-boot .embers i { position: absolute; bottom: -10px; width: 3px; height: 3px; border-radius: 50%;
        background: #ffb347; box-shadow: 0 0 8px 2px rgba(255, 140, 40, .7); opacity: 0;
        animation: wboot-rise linear infinite; }
      #wenilla-boot .box { position: relative; width: min(620px, 86vw); text-align: center; }
      #wenilla-boot .bar, #wenilla-boot .stage, #wenilla-boot .data { width: min(460px, 82vw); margin-left: auto; margin-right: auto; }
      #wenilla-boot .title { font: 88px/1.05 WowMorpheus, Georgia, serif; letter-spacing: .01em;
        background: linear-gradient(#fff3b0 0%, #ffd25a 38%, #d98a14 62%, #7a3d06 100%);
        -webkit-background-clip: text; background-clip: text; color: transparent;
        filter: drop-shadow(0 3px 0 #1a0b00) drop-shadow(0 0 22px rgba(255, 150, 30, .35)); }
      #wenilla-boot .by { margin: 1rem 0 2.6rem; font-size: 13px; letter-spacing: .04em; color: #a8956b; }
      #wenilla-boot .stage { margin-bottom: .7rem; min-height: 1.2em; color: #e9dcb8; }
      #wenilla-boot .bar { position: relative; height: 10px; border: 1px solid #6b5426; border-radius: 6px;
        background: linear-gradient(#120c06, #1d140a); overflow: hidden;
        box-shadow: 0 0 0 1px #000, inset 0 1px 3px #000; }
      #wenilla-boot .bar > i { position: relative; display: block; height: 100%; width: 0;
        background: linear-gradient(90deg, #8a1c0a, #e0631c 55%, #ffd25a);
        box-shadow: 0 0 12px rgba(255, 150, 40, .6); transition: width .2s linear; }
      #wenilla-boot .bar > i::after { content: ''; position: absolute; right: -3px; top: -4px; bottom: -4px; width: 8px;
        border-radius: 50%; background: #fff4c2; box-shadow: 0 0 10px 4px rgba(255, 200, 90, .8); }
      #wenilla-boot .bar.pulse > i { width: 28% !important; animation: wboot-slide 1.4s ease-in-out infinite; }
      #wenilla-boot .data { margin-top: .6rem; font-size: 12px; color: #8a7a5c; min-height: 1.2em; }
      #wenilla-boot .tip { margin-top: 2.2rem; font-size: 14px; color: #c8b68a; min-height: 2.6em; font-style: italic;
        transition: opacity .5s ease; }
      #wenilla-boot .err { color: #ff7a6a; }
      @keyframes wboot-slide { 0% { margin-left: 0 } 50% { margin-left: 72% } 100% { margin-left: 0 } }
      @keyframes wboot-spin { to { transform: rotate(360deg) } }
      @keyframes wboot-rise { 0% { transform: translateY(0); opacity: 0 } 10% { opacity: .9 }
        100% { transform: translateY(-105vh) translateX(var(--dx)); opacity: 0 } }
      @media (prefers-reduced-motion: reduce) {
        #wenilla-boot::before, #wenilla-boot .embers i { animation: none; } }
    </style>
    <div class="embers"></div>
    <div class="box">
      <div class="title">Heroes of Azeroth</div>
      <div class="by">a fan-made Warcraft card battler</div>
      <div class="by">Not affiliated with or endorsed by Blizzard Entertainment.</div>
      <div class="stage">Loading…</div>
      <div class="bar"><i></i></div>
      <div class="data"></div>
      <div class="tip"></div>
    </div>`;
  const embers = root.querySelector('.embers');
  for (let i = 0; i < 26; i++) {
    const e = document.createElement('i');
    e.style.left = `${Math.random() * 100}%`;
    e.style.setProperty('--dx', `${(Math.random() - 0.5) * 120}px`);
    e.style.animationDuration = `${7 + Math.random() * 9}s`;
    e.style.animationDelay = `${-Math.random() * 14}s`;
    embers.appendChild(e);
  }
  const tips = [
    'Every hero starts with ten cards: three Strikes, four Defends and one card from each specialization.',
    'At a rest site, heal or upgrade one card. You cannot do both.',
    'Elites are harder, but always drop gear and a trinket.',
    'Hover a trinket in combat to read exactly what it does.',
    'The campaign ends in the Plaguelands or the Burning Steppes. The seed decides which.',
    'You may change specialization between maps, never during one.',
  ];
  const tipEl = root.querySelector('.tip');
  let tipN = Math.floor(Math.random() * tips.length);
  tipEl.textContent = tips[tipN];
  const tipTimer = setInterval(() => {
    tipEl.style.opacity = '0';
    setTimeout(() => {
      tipN = (tipN + 1) % tips.length;
      tipEl.textContent = tips[tipN];
      tipEl.style.opacity = '1';
    }, 500);
  }, 5000);
  document.body.appendChild(root);
  const stageEl = root.querySelector('.stage');
  const barEl = root.querySelector('.bar');
  const fillEl = root.querySelector('.bar > i');
  const dataEl = root.querySelector('.data');
  let gone = false;
  let timeout = 0;
  const mb = (n) => (n / (1024 * 1024)).toFixed(0);
  return {
    setWasmProgress(got, total) {
      if (gone) return;
      if (total > 0) {
        const pct = Math.min(99, Math.floor((got / total) * 100));
        const done = got >= total;
        stageEl.textContent = done
          ? 'Summoning the horde…'
          : `Downloading the client — ${pct}%`;
        fillEl.style.width = (done ? 100 : pct) + '%';
      } else {
        stageEl.textContent = `Downloading client — ${mb(got)} MB`;
        barEl.classList.add('pulse');
      }
    },
    setData(done, total) {
      if (gone) return;
      dataEl.textContent = total > 0 && done < total ? `warming game data ${done} / ${total}` : '';
    },
    setStage(text) {
      if (gone) return;
      stageEl.textContent = text;
      barEl.classList.add('pulse');
    },
    fail(text) {
      clearTimeout(timeout);
      barEl.remove();
      dataEl.remove();
      clearInterval(tipTimer);
      stageEl.className = 'err';
      stageEl.textContent = text;
    },
    armTimeout(ms) {
      timeout = setTimeout(() => this.hide(), ms);
    },
    hide() {
      if (gone) return;
      gone = true;
      clearTimeout(timeout);
      clearInterval(tipTimer);
      root.classList.add('gone');
      setTimeout(() => root.remove(), 700);
    },
  };
}
