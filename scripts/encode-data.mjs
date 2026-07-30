// Encodes packages/core/src/data/*.json into compact, LOSSLESS binary (.bin)
// consumed by packages/core/src/lib/bindata.ts (JS) and, for region, by
// apps/desktop/src-tauri/src/math.rs (Rust). Run: bun scripts/encode-data.mjs
//
// Formats (all little-endian; "varint" = unsigned LEB128):
//   time.bin   : version | scale(1000) | numDepths
//                per depth: depthKey | rowCount | 4 columns P,S,R,D of
//                rowCount delta-varints of round(v*scale) (monotonic → >=0).
//   region.bin : version | numCities
//                per city: strLen+utf8 name | numTowns
//                per town: strLen+utf8 name | code(varint) | lat(f64) | lon(f64)
//                (unused site/area fields are dropped — no code reads them.)
//   box.bin    : version | scale(100) | numFeatures
//                per feature: ID(varint) | numPoints | points of lon,lat varints
//                of round(coord*scale) (Taiwan coords are positive, 2 decimals).
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const DATA = resolve(import.meta.dir, "../packages/core/src/data");

function pushVarint(arr, n) {
  if (n < 0 || !Number.isInteger(n)) throw new Error(`varint needs a non-negative int, got ${n}`);
  while (n > 0x7f) {
    arr.push((n & 0x7f) | 0x80);
    n = Math.floor(n / 128);
  }
  arr.push(n);
}

function pushF64(arr, v) {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setFloat64(0, v, true); // little-endian
  for (const x of b) arr.push(x);
}

function pushStr(arr, s) {
  const bytes = Buffer.from(s, "utf8");
  pushVarint(arr, bytes.length);
  for (const x of bytes) arr.push(x);
}

const jsonBytes = (o) => Buffer.byteLength(JSON.stringify(o));

function encodeTime() {
  const json = JSON.parse(readFileSync(resolve(DATA, "time.json"), "utf8"));
  const SCALE = 1000;
  const cols = ["P", "S", "R", "D"];
  const depths = Object.keys(json);
  const out = [];
  pushVarint(out, 1);
  pushVarint(out, SCALE);
  pushVarint(out, depths.length);
  for (const dk of depths) {
    const rows = json[dk];
    pushVarint(out, Number(dk));
    pushVarint(out, rows.length);
    for (const c of cols) {
      let prev = 0;
      for (const r of rows) {
        const iv = Math.round(r[c] * SCALE);
        if (iv / SCALE !== r[c]) throw new Error(`time lossy at depth ${dk} ${c}=${r[c]}`);
        const delta = iv - prev;
        if (delta < 0) throw new Error(`time non-monotonic ${c} at depth ${dk}`);
        pushVarint(out, delta);
        prev = iv;
      }
    }
  }
  const buf = Uint8Array.from(out);
  writeFileSync(resolve(DATA, "time.bin"), buf);
  return { name: "time", jsonBytes: jsonBytes(json), binBytes: buf.length };
}

function encodeRegion() {
  const json = JSON.parse(readFileSync(resolve(DATA, "region.json"), "utf8"));
  const cities = Object.keys(json);
  const out = [];
  pushVarint(out, 1);
  pushVarint(out, cities.length);
  for (const city of cities) {
    pushStr(out, city);
    const towns = Object.keys(json[city]);
    pushVarint(out, towns.length);
    for (const town of towns) {
      const t = json[city][town];
      pushStr(out, town);
      pushVarint(out, t.code);
      pushF64(out, t.lat);
      pushF64(out, t.lon);
    }
  }
  const buf = Uint8Array.from(out);
  writeFileSync(resolve(DATA, "region.bin"), buf);
  return { name: "region", jsonBytes: jsonBytes(json), binBytes: buf.length };
}

function encodeBox() {
  const json = JSON.parse(readFileSync(resolve(DATA, "box.json"), "utf8"));
  const SCALE = 100;
  const feats = json.features;
  const out = [];
  pushVarint(out, 1);
  pushVarint(out, SCALE);
  pushVarint(out, feats.length);
  for (const f of feats) {
    pushVarint(out, f.properties.ID);
    const ring = f.geometry.coordinates[0]; // confirmed max 1 ring per feature
    pushVarint(out, ring.length);
    for (const [lon, lat] of ring) {
      const li = Math.round(lon * SCALE);
      const la = Math.round(lat * SCALE);
      if (li / SCALE !== lon || la / SCALE !== lat) throw new Error(`box lossy ${lon},${lat}`);
      pushVarint(out, li);
      pushVarint(out, la);
    }
  }
  const buf = Uint8Array.from(out);
  writeFileSync(resolve(DATA, "box.bin"), buf);
  return { name: "box", jsonBytes: jsonBytes(json), binBytes: buf.length };
}

const results = [encodeTime(), encodeRegion(), encodeBox()];
for (const r of results) {
  const pct = ((1 - r.binBytes / r.jsonBytes) * 100).toFixed(1);
  console.log(
    `${r.name.padEnd(7)} ${(r.jsonBytes / 1024).toFixed(0).padStart(4)}KB json → ${(r.binBytes / 1024).toFixed(0).padStart(4)}KB bin (${pct}% smaller)`,
  );
}
