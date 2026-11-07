# Heroes of Azeroth: browser playtest

A private-style technical playtest of **Heroes of Azeroth**, a roguelike deck-builder set in the world of Warcraft,
running in the browser (Rust + Bevy compiled to WebAssembly, WebGPU).

- Play: https://shin-godji.github.io/heroes-of-azeroth/
- Needs a desktop browser with WebGPU (current Chrome or Edge).
- This is only a **test slice** (the Human / Elwynn path), not the full game. Other races and zones will show missing content.
- First load downloads about 250 MB; later visits reuse the browser cache.

This repository holds only the built site (page scripts, the WebAssembly build and the data files the test slice reads). The game's source
code is not in this repository.

Unofficial fan project. Not affiliated with or endorsed by Blizzard Entertainment. World of Warcraft and related names are
trademarks of Blizzard Entertainment, Inc.
