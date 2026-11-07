# TREM-Lite Native

The desktop app without a web view: Rust, winit and wgpu. A trial, to decide whether it is
worth continuing. `PORTING.md` is how it was ported.

```sh
cargo run --release                 # with its windows
cargo run --release -- --start      # to the tray only, as a login item does
packaging/bundle-macos.sh           # target/release/TREM-Lite Native.app, signed ad hoc
```

Windows and Linux need nothing but `cargo build --release`; Linux also needs the ALSA,
speech-dispatcher, D-Bus and fontconfig development packages. The manual workflow
`Native trial build` makes all three.

It keeps its own settings, logs and cache under `com.exptech.trem-lite.native`, apart from
the installed app, and has its own single-instance lock, so both can run side by side.

## Looking at it without a window

```sh
trem-lite-native --screenshot out.png --page main --preview eew     # preview.tsx's states
trem-lite-native --screenshot out.png --page pip --preview trigger
trem-lite-native --screenshot out.png --page settings --settings-tab 音效 --click 850,120
```

`TREM_FIXTURE_DIR=<dir>` answers every request from that directory instead of the network,
silently: no sound, no notification, no speech. With it, `--page run --replay <report id>
--after 50` runs the real app through a recorded earthquake and shoots the 50th second.

## Tests and measuring

```sh
cargo test                       # behaviour, event traces and pictures
UPDATE_GOLDEN=1 cargo test       # after a change meant to alter them
cargo test --release bench -- --ignored --nocapture --test-threads=1
```

Pictures are compared with a small tolerance. Characters the embedded Noto subset lacks are
drawn with the system fonts, as in the Tauri app, so the pictures hold on a Mac like the one
they were made on.

The log says how long the first frame took (`第一幀：啟動後 … ms`). Two things skew it: with
the display asleep the window counts as occluded and nothing is drawn at all, and the first
launch of a new build compiles its GPU pipelines (~300 ms on an M4 Max), which later
launches find cached.

## Where it differs from the Tauri app

- No update channel: 檢查更新 says so, and nothing is downloaded or installed.
- `other-auto-start` starts off, so trying it adds no login item.
- PiP fills its window rather than leaving 1% transparent at the edges.
- The station menu takes Esc, and no arrow keys.
- A wheel zoom lands at once rather than easing over 200 ms.
