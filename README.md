# Heroes of Azeroth

A roguelike deck-builder in the world of Warcraft, playable in the browser (Rust + Bevy compiled to WebAssembly, WebGPU).
Play it at https://shin-godji.github.io/heroes-of-azeroth/

This repository is the published build of the full game: eight races, every class and specialization, seven maps and
their encounters, cards, effects, music and ambience. The game data ships as lazy gzip bundles (`bundles/`, loaded when a
race or map needs them), the engine as a gzipped wasm (`b/`), the opening music and artwork beside the page (`hoa/`).

Requirements: a recent desktop Chrome or Edge with WebGPU. The first visit downloads the engine and the title assets
(about 75 MB), each map a further 15-70 MB; later visits are served from the browser cache.

World of Warcraft and its art, music and sounds belong to Blizzard Entertainment. This is an unofficial fan project.
