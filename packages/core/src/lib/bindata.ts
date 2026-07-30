/**
 * Dedicated decoders for the compact binary data files produced by
 * scripts/encode-data.mjs. Lossless: values are reconstructed exactly (see the
 * scale/decimal argument in the encoder).
 */

/** Sequential reader (unsigned-LEB128 varints, LE f64, length-prefixed utf8). */
class Reader {
  private pos = 0;
  private readonly view: DataView;
  private readonly dec = new TextDecoder();
  constructor(private readonly buf: Uint8Array) {
    this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  }
  varint(): number {
    let result = 0;
    let shift = 1; // 2**0
    let b: number;
    do {
      b = this.buf[this.pos++];
      result += (b & 0x7f) * shift;
      shift *= 128;
    } while (b & 0x80);
    return result;
  }
  f64(): number {
    const v = this.view.getFloat64(this.pos, true);
    this.pos += 8;
    return v;
  }
  str(): string {
    const len = this.varint();
    const s = this.dec.decode(this.buf.subarray(this.pos, this.pos + len));
    this.pos += len;
    return s;
  }
  get done(): boolean {
    return this.pos >= this.buf.length;
  }
}

const bytes = (buf: ArrayBuffer | Uint8Array): Uint8Array =>
  buf instanceof Uint8Array ? buf : new Uint8Array(buf);

export interface TimeTableRow {
  P: number;
  S: number;
  R: number;
  D: number;
}
export type TimeTable = Record<string, TimeTableRow[]>;

/** Decode time.bin → the depth→rows table EEWCalculator expects. */
export function decodeTimeTable(buf: ArrayBuffer | Uint8Array): TimeTable {
  const r = new Reader(bytes(buf));
  r.varint(); // version
  const scale = r.varint();
  const numDepths = r.varint();
  const cols = ["P", "S", "R", "D"] as const;
  const table: TimeTable = {};

  for (let i = 0; i < numDepths; i++) {
    const depth = r.varint();
    const rowCount = r.varint();
    const acc: Record<string, number[]> = { P: [], S: [], R: [], D: [] };
    for (const c of cols) {
      const arr = acc[c];
      let prev = 0;
      for (let j = 0; j < rowCount; j++) {
        prev += r.varint();
        arr.push(prev / scale);
      }
    }
    const rows: TimeTableRow[] = new Array(rowCount);
    for (let j = 0; j < rowCount; j++) {
      rows[j] = { P: acc.P[j], S: acc.S[j], R: acc.R[j], D: acc.D[j] };
    }
    table[String(depth)] = rows;
  }
  return table;
}

export interface RegionTown {
  code: number;
  lat: number;
  lon: number;
}
export type Region = Record<string, Record<string, RegionTown>>;

/** Decode region.bin → { city: { town: { code, lat, lon } } }. */
export function decodeRegion(buf: ArrayBuffer | Uint8Array): Region {
  const r = new Reader(bytes(buf));
  r.varint(); // version
  const numCities = r.varint();
  const region: Region = {};
  for (let i = 0; i < numCities; i++) {
    const city = r.str();
    const numTowns = r.varint();
    const towns: Record<string, RegionTown> = {};
    for (let j = 0; j < numTowns; j++) {
      const town = r.str();
      const code = r.varint();
      const lat = r.f64();
      const lon = r.f64();
      towns[town] = { code, lat, lon };
    }
    region[city] = towns;
  }
  return region;
}

export interface BoxFeature {
  geometry: { type: "Polygon"; coordinates: number[][][] };
  properties: { ID: number };
}
export interface BoxData {
  type: "FeatureCollection";
  features: BoxFeature[];
}

/** Decode box.bin → a GeoJSON-shaped FeatureCollection (single-ring polygons). */
export function decodeBox(buf: ArrayBuffer | Uint8Array): BoxData {
  const r = new Reader(bytes(buf));
  r.varint(); // version
  const scale = r.varint();
  const numFeatures = r.varint();
  const features: BoxFeature[] = [];
  for (let i = 0; i < numFeatures; i++) {
    const ID = r.varint();
    const n = r.varint();
    const ring: number[][] = new Array(n);
    for (let k = 0; k < n; k++) {
      const lon = r.varint() / scale;
      const lat = r.varint() / scale;
      ring[k] = [lon, lat];
    }
    features.push({ geometry: { type: "Polygon", coordinates: [ring] }, properties: { ID } });
  }
  return { type: "FeatureCollection", features };
}
