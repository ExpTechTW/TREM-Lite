#!/bin/sh
# The browser build, into web/dist: the app for wasm32, wasm-bindgen's glue, the page and
# the sound clips the web app already serves. Needs the wasm32-unknown-unknown target and
# wasm-bindgen-cli at the version in Cargo.lock.
set -eu
cd "$(dirname "$0")/.."
cargo build --release --target wasm32-unknown-unknown
rm -rf web/dist
wasm-bindgen --target web --no-typescript --out-dir web/dist --out-name trem \
  target/wasm32-unknown-unknown/release/trem-lite-native.wasm
cp web/index.html web/dist/
mkdir -p web/dist/audio
cp ../../packages/core/static/audio/*.mp3 web/dist/audio/
ls -l web/dist/trem_bg.wasm
