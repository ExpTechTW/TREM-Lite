/**
 * The intensity model (ML v1, `intensity_ml_v1.onnx`) for the web: the desktop
 * evaluator (src-tauri/src/ml_intensity.rs) ported op for op, so a browser
 * predicts what the desktop does, to the bit.
 *
 * The model is a physics formula plus four gradient-boosted tree ensembles; a
 * 10-value feature row gives PGA (gal) and PGV (cm/s), and the town's level is
 * the higher of the two on CWA's bounds. Everything runs in f32 the way
 * single-threaded onnxruntime runs it:
 *
 *   * each value is stored in a Float32Array, which rounds it — for one add or
 *     multiply of two f32 that equals f32 arithmetic (f64 has more than twice
 *     the precision, so the double rounding is harmless);
 *   * a fused multiply-add, which MLAS's Exp kernel uses, is emulated exactly:
 *     the f64 sum rounded to odd, then to f32 (`fma32`);
 *   * trees are summed in tree order with the base value last.
 *
 * Loading is strict: an op, attribute or tree shape this does not implement is
 * rejected rather than approximated. Pure: no DOM, so it runs in a worker.
 */
export const N_FEAT = 10;

/** SHA-256 of the file. Anything else is not used (see ml_intensity.rs). */
export const MODEL_SHA256 = "cf2969c816d64413d12d9fa3949e34424529189cc395ca718c8421188ddb5517";

/** The radius the training features used, not the app's 6371.008. */
const EARTH_KM = 6371.0;
const D2R = Math.PI / 180;

/** CWA bounds (model_config_v1.json): a level is reached AT its bound. */
const PGA_BOUNDS = [0.8, 2.5, 8.0, 25.0, 80.0, 140.0, 250.0, 440.0, 800.0];
const PGV_BOUNDS = [0.2, 0.7, 1.9, 5.7, 15.0, 30.0, 50.0, 80.0, 140.0];

/**
 * The feature row for one epicentre and target point, in f64 then rounded to
 * f32: M, depth, dist, lnR, evLat, evLon, tLat, tLon, sinAz, cosAz.
 */
export function features(
  row: Float32Array,
  at: number,
  mag: number,
  depth: number,
  evLat: number,
  evLon: number,
  tLat: number,
  tLon: number,
): void {
  const p1 = evLat * D2R;
  const p2 = tLat * D2R;
  const dl = (tLon - evLon) * D2R;
  const s1 = Math.sin((p2 - p1) / 2);
  const s2 = Math.sin(dl / 2);
  const a = s1 * s1 + Math.cos(p1) * Math.cos(p2) * (s2 * s2);
  const dist = 2 * EARTH_KM * Math.asin(Math.sqrt(a));
  const lnR = Math.log(Math.max(Math.hypot(dist, depth), 3));
  const az = Math.atan2(
    Math.sin(dl) * Math.cos(p2),
    Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl),
  );
  row.set([mag, depth, dist, lnR, evLat, evLon, tLat, tLon, Math.sin(az), Math.cos(az)], at);
}

/** CWA level (0-9) for a predicted PGA and PGV: the higher classification. */
export function level(pga: number, pgv: number): number {
  const classify = (v: number, bounds: number[]) => bounds.filter((b) => v >= b).length;
  return Math.max(classify(pga, PGA_BOUNDS), classify(pgv, PGV_BOUNDS));
}

// ─── f32 bits ────────────────────────────────────────────────────────────────

const f32 = new Float32Array(1);
const u32 = new Uint32Array(f32.buffer);
const f64 = new Float64Array(1);
const u64 = new Uint32Array(f64.buffer); // [low, high] on every little-endian host

function fromBits(b: number): number {
  u32[0] = b;
  return f32[0];
}

function toBits(x: number): number {
  f32[0] = x;
  return u32[0];
}

/** The next f32 toward -inf (finite, non-NaN input). */
function nextDown(x: number): number {
  if (x === 0) return -fromBits(1);
  const b = toBits(x);
  return fromBits(x > 0 ? b - 1 : b + 1);
}

/**
 * f32 fused multiply-add of f32 operands: a·b + c rounded once. a·b is exact
 * in f64; the sum is rounded to f64 "to odd" (its error, from TwoSum, moves an
 * even result one ulp toward the true sum), after which rounding to f32 is
 * the correctly rounded result.
 */
function fma32(a: number, b: number, c: number): number {
  const p = a * b;
  const s = p + c;
  const bb = s - p;
  const err = p - (s - bb) + (c - bb);
  if (err === 0) return Math.fround(s);
  f64[0] = s;
  if ((u64[0] & 1) === 0) {
    // One ulp toward the true sum: away from zero when the error points there.
    const lo = u64[0] + ((err > 0) === (s > 0) ? 1 : -1);
    u64[1] += lo < 0 ? -1 : lo > 0xffffffff ? 1 : 0;
    u64[0] = lo >>> 0;
  }
  return Math.fround(f64[0]);
}

/**
 * onnxruntime's f32 Exp: MLAS `MlasComputeExpF32Kernel`, constants (as their
 * exact f32 bits) and operation order as there, every multiply-add fused.
 */
const EXP_LOWER = fromBits(0xc2cff1b5);
const EXP_UPPER = fromBits(0x42b18d72);
const ROUNDING_BIAS = 12_582_912; // 1.5·2^23
const LOG2_RECIP = fromBits(0x3fb8aa3b);
const LOG2_HIGH = fromBits(0xbf317200);
const LOG2_LOW = fromBits(0xb5bfbe8e);
const POLY = [0x3ab4a000, 0x3c092f6e, 0x3d2aadad, 0x3e2aaa28, 0x3efffffb].map(fromBits).concat(1);
const MIN_EXPONENT = 0xc1000000 | 0;
const MAX_EXPONENT = 0x3f800000;

export function mlasExp(input: number): number {
  let x = Math.min(Math.max(input, EXP_LOWER), EXP_UPPER);
  const biased = fma32(x, LOG2_RECIP, ROUNDING_BIAS);
  const m = Math.fround(biased - ROUNDING_BIAS);
  x = fma32(m, LOG2_HIGH, x);
  x = fma32(m, LOG2_LOW, x);
  const shifted = (toBits(biased) << 23) | 0;
  const normal = Math.min(Math.max(shifted, MIN_EXPONENT), MAX_EXPONENT);
  const overflow = (shifted - normal + MAX_EXPONENT) | 0;
  let p = POLY[0];
  for (let k = 1; k < POLY.length; k++) p = fma32(p, x, POLY[k]);
  const of = fromBits(overflow >>> 0);
  p = fma32(p, Math.fround(x * of), of);
  return Math.fround(p * fromBits((normal + MAX_EXPONENT) >>> 0));
}

// ─── Minimal protobuf reader ─────────────────────────────────────────────────

interface Field {
  num: number;
  wire: number;
  /** Value of a varint (wire 0) or fixed32 (wire 5) field. */
  v: number;
  /** Bytes of a length-delimited (wire 2) field. */
  b: Uint8Array;
}

const utf8 = new TextDecoder("utf-8", { fatal: true });
const EMPTY: Uint8Array = new Uint8Array(0);

/** A varint at `buf[at]`: [value, next offset]. Beyond 2^53 only int64 ids, never here. */
function varint(buf: Uint8Array, at: number): [number, number] {
  let v = 0;
  let scale = 1;
  for (let i = 0; i < 10; i++) {
    if (at >= buf.length) throw new Error("onnx: truncated varint");
    const byte = buf[at++];
    v += (byte & 0x7f) * scale;
    if ((byte & 0x80) === 0) return [v, at];
    scale *= 128;
  }
  throw new Error("onnx: varint too long");
}

function fields(buf: Uint8Array, f: (field: Field) => void): void {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let at = 0;
  while (at < buf.length) {
    let key: number;
    [key, at] = varint(buf, at);
    const field: Field = { num: Math.floor(key / 8), wire: key & 7, v: 0, b: EMPTY };
    switch (field.wire) {
      case 0:
        [field.v, at] = varint(buf, at);
        break;
      case 1:
        if (at + 8 > buf.length) throw new Error("onnx: truncated field");
        at += 8; // fixed64: nothing this model reads
        break;
      case 2: {
        let n: number;
        [n, at] = varint(buf, at);
        if (at + n > buf.length) throw new Error("onnx: truncated field");
        field.b = buf.subarray(at, at + n);
        at += n;
        break;
      }
      case 5:
        if (at + 4 > buf.length) throw new Error("onnx: truncated field");
        field.v = view.getUint32(at, true);
        at += 4;
        break;
      default:
        throw new Error(`onnx: unsupported wire type ${field.wire}`);
    }
    f(field);
  }
}

/** Little-endian f32s from bytes that may not be 4-aligned. */
function floatsOf(b: Uint8Array): Float32Array {
  if (b.length % 4) throw new Error("onnx: malformed float field");
  return new Float32Array(b.slice().buffer);
}

function pushFloats(dst: number[], f: Field): void {
  if (f.wire === 5) dst.push(fromBits(f.v));
  else if (f.wire === 2) for (const v of floatsOf(f.b)) dst.push(v);
  else throw new Error("onnx: malformed float field");
}

function pushInts(dst: number[], f: Field): void {
  if (f.wire === 0) dst.push(f.v);
  else if (f.wire === 2) {
    for (let at = 0; at < f.b.length; ) {
      let v: number;
      [v, at] = varint(f.b, at);
      dst.push(v);
    }
  } else throw new Error("onnx: malformed int field");
}

interface Attr {
  i: number;
  s: string;
  floats: number[];
  ints: number[];
  strings: string[];
}

interface Node {
  opType: string;
  domain: string;
  inputs: string[];
  outputs: string[];
  attrs: Map<string, Attr>;
}

interface Graph {
  nodes: Node[];
  floats: Map<string, Float32Array>;
  ints: Map<string, number[]>;
  inputs: string[];
}

function parseModel(buf: Uint8Array): Graph {
  let graphBytes: Uint8Array | null = null;
  fields(buf, (f) => {
    if (f.num === 7 && f.wire === 2) graphBytes = f.b; // ModelProto.graph
  });
  if (!graphBytes) throw new Error("onnx: model has no graph");
  const g: Graph = { nodes: [], floats: new Map(), ints: new Map(), inputs: [] };
  fields(graphBytes, (f) => {
    if (f.num === 1) g.nodes.push(parseNode(f.b));
    else if (f.num === 5) parseTensor(f.b, g);
    else if (f.num === 11) {
      let name = "";
      fields(f.b, (v) => {
        if (v.num === 1) name = utf8.decode(v.b);
      });
      g.inputs.push(name);
    }
  });
  return g;
}

function parseNode(buf: Uint8Array): Node {
  const n: Node = { opType: "", domain: "", inputs: [], outputs: [], attrs: new Map() };
  fields(buf, (f) => {
    switch (f.num) {
      case 1:
        n.inputs.push(utf8.decode(f.b));
        break;
      case 2:
        n.outputs.push(utf8.decode(f.b));
        break;
      case 4:
        n.opType = utf8.decode(f.b);
        break;
      case 7:
        n.domain = utf8.decode(f.b);
        break;
      case 5: {
        let name = "";
        const a: Attr = { i: 0, s: "", floats: [], ints: [], strings: [] };
        fields(f.b, (v) => {
          if (v.num === 1) name = utf8.decode(v.b);
          else if (v.num === 3) a.i = v.v;
          else if (v.num === 4) a.s = utf8.decode(v.b);
          else if (v.num === 7) pushFloats(a.floats, v);
          else if (v.num === 8) pushInts(a.ints, v);
          else if (v.num === 9) a.strings.push(utf8.decode(v.b));
        });
        n.attrs.set(name, a);
        break;
      }
    }
  });
  return n;
}

function parseTensor(buf: Uint8Array, g: Graph): void {
  let name = "";
  let dtype = 0;
  let raw = EMPTY;
  const floats: number[] = [];
  const ints: number[] = [];
  fields(buf, (f) => {
    if (f.num === 2) dtype = f.v;
    else if (f.num === 4) pushFloats(floats, f);
    else if (f.num === 7) pushInts(ints, f);
    else if (f.num === 8) name = utf8.decode(f.b);
    else if (f.num === 9) raw = f.b;
  });
  if (dtype === 1) {
    g.floats.set(name, Float32Array.from([...floats, ...floatsOf(raw.subarray(0, raw.length - (raw.length % 4)))]));
  } else if (dtype === 7) {
    const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
    for (let at = 0; at + 8 <= raw.length; at += 8) ints.push(Number(view.getBigInt64(at, true)));
    g.ints.set(name, ints);
  } else {
    throw new Error(`onnx: initializer ${JSON.stringify(name)} has unsupported type ${dtype}`);
  }
}

// ─── Compiled graph ──────────────────────────────────────────────────────────

/** Where an op reads a value: a broadcast constant or a column of the batch. */
type Arg = { c: number } | { col: number };

type Op =
  | { kind: "gather"; feat: number }
  | { kind: "add" | "mul"; a: Arg; b: Arg }
  | { kind: "exp" | "copy"; a: Arg }
  | { kind: "trees"; forest: Forest };

export interface Model {
  steps: { op: Op; out: number }[];
  nCols: number;
  pga: number;
  pgv: number;
}

export function loadModel(bytes: Uint8Array): Model {
  return compile(parseModel(bytes));
}

function compile(g: Graph): Model {
  if (g.inputs.length !== 1) throw new Error(`onnx: want 1 graph input, have ${g.inputs.length}`);
  const [input] = g.inputs;
  const cols = new Map<string, number>();
  const steps: Model["steps"] = [];
  const arg = (name: string): Arg => {
    const col = cols.get(name);
    if (col !== undefined) return { col };
    const v = g.floats.get(name);
    if (!v) throw new Error(`onnx: ${JSON.stringify(name)} is read before it is produced`);
    if (v.length !== 1) throw new Error(`onnx: constant ${JSON.stringify(name)} has ${v.length} elements, want 1`);
    return { c: v[0] };
  };
  for (const n of g.nodes) {
    if (n.outputs.length !== 1) throw new Error(`onnx: ${n.opType} has ${n.outputs.length} outputs, want 1`);
    const inputAt = (i: number) => {
      const name = n.inputs[i];
      if (name === undefined) throw new Error(`onnx: ${n.opType} is missing input ${i}`);
      return name;
    };
    let op: Op;
    const kind = `${n.domain}/${n.opType}`;
    if (kind === "/Gather") {
      const axis = n.attrs.get("axis")?.i ?? 0;
      if (inputAt(0) !== input || axis !== 1) throw new Error(`onnx: only Gather(${input}, axis=1) is supported`);
      const idx = g.ints.get(inputAt(1));
      if (!idx || idx.length !== 1 || idx[0] < 0 || idx[0] >= N_FEAT) {
        throw new Error(`onnx: Gather index ${JSON.stringify(idx)} out of range`);
      }
      op = { kind: "gather", feat: idx[0] };
    } else if (kind === "/Add" || kind === "/Mul") {
      op = { kind: kind === "/Add" ? "add" : "mul", a: arg(inputAt(0)), b: arg(inputAt(1)) };
    } else if (kind === "/Exp" || kind === "/Identity") {
      op = { kind: kind === "/Exp" ? "exp" : "copy", a: arg(inputAt(0)) };
    } else if (kind === "ai.onnx.ml/TreeEnsembleRegressor") {
      if (inputAt(0) !== input) throw new Error(`onnx: trees must read the graph input ${JSON.stringify(input)}`);
      op = { kind: "trees", forest: compileForest(n.attrs) };
    } else {
      throw new Error(`onnx: unsupported op ${kind}`);
    }
    const col = cols.size;
    cols.set(n.outputs[0], col);
    steps.push({ op, out: col });
  }
  const pga = cols.get("PGA");
  const pgv = cols.get("PGV");
  if (pga === undefined || pgv === undefined) throw new Error("onnx: graph must compute PGA and PGV");
  return { steps, nCols: cols.size, pga, pgv };
}

/** PGA (gal) and PGV (cm/s) for `n` rows of N_FEAT f32 features each. */
export function predict(model: Model, rows: Float32Array, n: number): { pga: Float32Array; pgv: Float32Array } {
  const cols: Float32Array[] = [];
  const get = (a: Arg, i: number) => ("c" in a ? a.c : cols[a.col][i]);
  for (const { op, out } of model.steps) {
    const col = new Float32Array(n);
    switch (op.kind) {
      case "gather":
        for (let i = 0; i < n; i++) col[i] = rows[i * N_FEAT + op.feat];
        break;
      case "add":
        for (let i = 0; i < n; i++) col[i] = get(op.a, i) + get(op.b, i);
        break;
      case "mul":
        for (let i = 0; i < n; i++) col[i] = get(op.a, i) * get(op.b, i);
        break;
      case "exp":
        for (let i = 0; i < n; i++) col[i] = mlasExp(get(op.a, i));
        break;
      case "copy":
        for (let i = 0; i < n; i++) col[i] = get(op.a, i);
        break;
      case "trees":
        evalForest(op.forest, rows, n, col);
        break;
    }
    cols[out] = col;
  }
  return { pga: cols[model.pga], pgv: cols[model.pgv] };
}

// ─── Tree ensembles ──────────────────────────────────────────────────────────

/**
 * A compiled `ai.onnx.ml` TreeEnsembleRegressor (one target, SUM, no post
 * transform): each branch's children sit side by side (true first) and every
 * test is "go right when x > thr", so a step is `child + (x > thr)`. Leaves
 * point at themselves with thr = +inf, so a tree is walked `depth` steps.
 */
interface Forest {
  thr: Float32Array;
  feat: Uint8Array;
  child: Uint32Array;
  /** Leaf weight by node index; 0 for branches. */
  values: Float32Array;
  roots: Uint32Array;
  depths: Uint8Array;
  base: number;
}

function compileForest(attrs: Map<string, Attr>): Forest {
  const none: Attr = { i: 0, s: "", floats: [], ints: [], strings: [] };
  const get = (k: string) => attrs.get(k) ?? none;
  if (get("n_targets").i !== 1) throw new Error(`onnx: trees: n_targets ${get("n_targets").i}, want 1`);
  for (const [k, ok] of [
    ["post_transform", "NONE"],
    ["aggregate_function", "SUM"],
  ]) {
    const v = get(k).s;
    if (v && v !== ok) throw new Error(`onnx: trees: ${k} ${v} not supported`);
  }
  const tree = get("nodes_treeids").ints;
  const node = get("nodes_nodeids").ints;
  const featIds = get("nodes_featureids").ints;
  const mode = get("nodes_modes").strings;
  const thrs = get("nodes_values").floats;
  const yes = get("nodes_truenodeids").ints;
  const no = get("nodes_falsenodeids").ints;
  const n = tree.length;
  if (n === 0 || [node, featIds, mode, thrs, yes, no].some((a) => a.length !== n)) {
    throw new Error("onnx: trees: node attribute lengths disagree");
  }
  // (tree, node) → one number; node ids stay far below 2^20.
  const key = (t: number, nd: number) => t * 1_048_576 + nd;
  const index = new Map<number, number>();
  for (let i = 0; i < n; i++) index.set(key(tree[i], node[i]), i);

  const tt = get("target_treeids").ints;
  const tn = get("target_nodeids").ints;
  const tid = get("target_ids").ints;
  const tw = get("target_weights").floats;
  if (tn.length !== tt.length || tid.length !== tt.length || tw.length !== tt.length) {
    throw new Error("onnx: trees: target attribute lengths disagree");
  }
  const weight = new Map<number, number>();
  for (let i = 0; i < tt.length; i++) {
    if (tid[i] !== 0) throw new Error(`onnx: trees: target id ${tid[i]}, want 0`);
    const k = key(tt[i], tn[i]);
    if (weight.has(k)) throw new Error(`onnx: trees: leaf ${tt[i]}/${tn[i]} has more than one weight`);
    weight.set(k, tw[i]);
  }

  const thr: number[] = [];
  const feat: number[] = [];
  const child: number[] = [];
  const values: number[] = [];
  const roots: number[] = [];
  const depths: number[] = [];
  const push = () => {
    thr.push(0);
    feat.push(0);
    child.push(0);
    values.push(0);
    return thr.length - 1;
  };

  // Summed in ascending tree id, the order onnxruntime uses.
  const trees: number[] = [];
  for (let i = 0; i < n; i++) if (node[i] === 0) trees.push(tree[i]);
  trees.sort((a, b) => a - b);
  for (const t of trees) {
    const root = push();
    const start = index.get(key(t, 0));
    if (start === undefined) throw new Error(`onnx: trees: tree ${t} has no root`);
    // Explicit stack instead of recursion: (onnx node, slot, depth).
    const stack: [number, number, number][] = [[start, root, 0]];
    let depth = 0;
    while (stack.length) {
      const [i, slot, d] = stack.pop()!;
      if (d > 255) throw new Error(`onnx: trees: tree ${t} too deep`);
      if (mode[i] === "LEAF") {
        thr[slot] = Infinity;
        feat[slot] = 0;
        child[slot] = slot;
        values[slot] = weight.get(key(t, node[i])) ?? 0;
        depth = Math.max(depth, d);
        continue;
      }
      if (mode[i] !== "BRANCH_LEQ" && mode[i] !== "BRANCH_LT") {
        throw new Error(`onnx: trees: node mode ${mode[i]} not supported`);
      }
      if (featIds[i] < 0 || featIds[i] >= N_FEAT) throw new Error(`onnx: trees: feature ${featIds[i]} out of range`);
      const ti = index.get(key(t, yes[i]));
      const fi = index.get(key(t, no[i]));
      if (ti === undefined || fi === undefined) throw new Error(`onnx: trees: tree ${t} has a dangling child`);
      const c = push();
      push();
      // x < t is x <= the f32 just below t, for every finite x.
      thr[slot] = mode[i] === "BRANCH_LT" ? nextDown(thrs[i]) : thrs[i];
      feat[slot] = featIds[i];
      child[slot] = c;
      stack.push([fi, c + 1, d + 1]);
      stack.push([ti, c, d + 1]);
    }
    roots.push(root);
    depths.push(depth);
  }
  return {
    thr: Float32Array.from(thr),
    feat: Uint8Array.from(feat),
    child: Uint32Array.from(child),
    values: Float32Array.from(values),
    roots: Uint32Array.from(roots),
    depths: Uint8Array.from(depths),
    base: get("base_values").floats[0] ?? 0,
  };
}

/** Ensemble output per row, into `out` (f32, so every addition rounds as f32). */
function evalForest(f: Forest, rows: Float32Array, n: number, out: Float32Array): void {
  const { thr, feat, child, values } = f;
  for (let t = 0; t < f.roots.length; t++) {
    const root = f.roots[t];
    const depth = f.depths[t];
    for (let i = 0; i < n; i++) {
      const base = i * N_FEAT;
      let nd = root;
      for (let d = 0; d < depth; d++) nd = child[nd] + (rows[base + feat[nd]] > thr[nd] ? 1 : 0);
      out[i] += values[nd];
    }
  }
  for (let i = 0; i < n; i++) out[i] += f.base;
}
