# Heroes of Azeroth

A roguelike deck-builder in the world of Warcraft, playable in the browser.
**Play it: https://shin-godji.github.io/heroes-of-azeroth/**

Pick one of eight races and one of nine classes, then fight your way across a branching map of
encounters, building a deck of cards as you go. The engine is a from-scratch World of Warcraft
1.12 client written in Rust with Bevy, compiled to WebAssembly and rendered with WebGPU, so the
fights are staged in the real game world rather than drawn as flat art.

Needs a recent desktop Chrome or Edge (WebGPU). The first visit downloads the engine and the
title screen, about 75 MB; each map you reach adds 15–70 MB. Later visits are served from the
browser's cache.

## What is in this repository

This is the published build, not the source: the engine as one compiled WebAssembly file, the
game data as compressed bundles, and the few page files that load them.

| Path | What it is |
|---|---|
| `b/<build>/` | **The engine.** The whole client compiled to WebAssembly and gzipped (about 21 MB). One folder per build; `config.json` names the one in use. |
| `bundles/` | **The game data**, in 156 content-hashed gzip bundles: terrain, models, textures, creature and spell sounds, cards, icons, and the title and loading-screen artwork. Each bundle belongs to a group that loads at a set moment — startup, a chosen race, a map — so a visit downloads only what it actually plays. |
| `data/` | **Streamed audio.** The 60 largest music and ambience files, served as ordinary files instead of bundled, because they stream while they play. |
| `hoa/music/` | **The opening track** (`the_titans.ogg`), fetched at the title screen and played once from Press Start until the first fight. |
| `snippets/` | A small JavaScript helper that the WebAssembly toolchain emits alongside the engine. |
| `vendor/` | pako, the gzip decompressor the bundle layer needs for its synchronous reads, with its licence. |
| `index.html` | **The page.** The canvas, and the patch that resumes audio on the first click or key press, since browsers keep sound suspended until the player interacts. |
| `boot.js` | **The loader and the loading screen you see first.** Downloads and unpacks the engine, shows the progress bar and the "Starting…" steps, and relays the game's own progress back to the page. |
| `bundles.js` | **The asset layer.** Answers every file the game asks for out of the bundles, fetches each group when its moment arrives, keeps bundles in Cache Storage so a repeat visit downloads nothing, and drops a map's data from memory once the run has left it. |
| `bundles.json` | The bundle manifest: every bundle, its group, and the moment that group loads. |
| `bundles-index.json` | The lookup table from a data file's path to the bundle that holds it. |
| `wenilla.js` | The generated glue between the page and the engine: the imports the WebAssembly module asks for. |
| `wasi_stubs.js` | Stand-ins for the filesystem and clock calls the engine's embedded Lua runtime expects and a browser cannot provide. |
| `platform.js` | Optional browser extras: full-screen key capture, and durable storage so settings survive a cleanup. |
| `bridge.js` | Optional JavaScript bridge: per-frame game state and events, for a page that wants to read or script the game. |
| `config.json` | Which build to load, and where the data and bundles live. |
| `favicon.svg` | The browser-tab icon. |
| `.nojekyll` | Tells GitHub Pages to serve these files exactly as they are, with no site generator in between. |

## Support

If you enjoy it: [ko-fi.com/shin_godji](https://ko-fi.com/shin_godji)

## Credits and status

Heroes of Azeroth is an unofficial fan project, in active development. Classes, cards and balance
are still changing; please report bugs, exploits and balance problems.

World of Warcraft and its art, music and sounds belong to Blizzard Entertainment. This project is
not affiliated with or endorsed by Blizzard.
