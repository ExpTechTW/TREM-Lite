//! Predicted intensity from the ML model YuYu1015-IntensityGMM-TW-45k-v1
//! (`intensity_ml_v1.onnx`, MD5 930ddd3c — the same file as cwa-eew-web's
//! models/intensity_ml_v1.onnx and rts-server-go's resource/intensity_ml_v1.onnx).
//!
//! The model is a physics formula plus four gradient-boosted tree ensembles
//! (XGBoost + LightGBM for PGA and for PGV, 700 trees each). From a 10-value
//! feature row it predicts PGA (gal) and PGV (cm/s); the town's level is the
//! higher of the two classified on CWA's bounds.
//!
//! The .onnx is read and executed here directly instead of through onnxruntime,
//! so the app ships no native ML runtime on any platform. The file is not in the
//! binary: [`prepare`] downloads it on first launch (the web build serves it)
//! and keeps it with the app's data, checked against its SHA-256 each time it
//! is read. Every op runs the way single-threaded onnxruntime runs it — f32
//! throughout, tree leaves summed in tree order with the base value last, no
//! fused multiply-adds, and `Exp` as MLAS's kernel — so PGA and PGV come out
//! bit-identical to onnxruntime (checked against it in the tests below).
//!
//! Loading is strict: any op, attribute or tree shape this evaluator does not
//! implement is rejected rather than approximated.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::Duration;

use sha2::{Digest, Sha256};
use tauri_plugin_http::reqwest;

/// The file's name, in the web build (packages/core/static/models) and here.
const FILE: &str = "intensity_ml_v1.onnx";
/// Where it is fetched from, in order: the web build on GitHub Pages, then the
/// repository's copy through jsDelivr.
const SOURCES: [&str; 2] = [
    "https://exptechtw.github.io/TREM-Lite/models/intensity_ml_v1.onnx",
    "https://cdn.jsdelivr.net/gh/ExpTechTW/TREM-Lite@main/packages/core/static/models/intensity_ml_v1.onnx",
];
/// The file's SHA-256. Anything else — a truncated download, an error page, a
/// different model — is not used.
const SHA256: &str = "cf2969c816d64413d12d9fa3949e34424529189cc395ca718c8421188ddb5517";
/// How long to wait before trying the download again, offline or on error.
const RETRY: Duration = Duration::from_secs(60);

/// Width of one input row: M, depth, dist, lnR, evLat, evLon, tLat, tLon,
/// sinAz, cosAz — the order the model was trained on.
pub const N_FEAT: usize = 10;
pub type Row = [f32; N_FEAT];

/// The radius the training features used. Not the 6371.008 the rest of the app
/// uses: a different radius shifts `dist`, which the trees split on.
const EARTH_KM: f64 = 6371.0;
const D2R: f64 = std::f64::consts::PI / 180.0;

/// CWA bounds (model_config_v1.json): a level is reached AT its bound.
const PGA_BOUNDS: [f64; 9] = [0.8, 2.5, 8.0, 25.0, 80.0, 140.0, 250.0, 440.0, 800.0];
const PGV_BOUNDS: [f64; 9] = [0.2, 0.7, 1.9, 5.7, 15.0, 30.0, 50.0, 80.0, 140.0];

/// Rows per worker below which splitting the batch costs more than it saves.
const MIN_ROWS_PER_WORKER: usize = 32;

static MODEL: OnceLock<Model> = OnceLock::new();

/// The compiled model, once [`prepare`] has it.
pub fn model() -> Result<&'static Model, String> {
    MODEL
        .get()
        .ok_or_else(|| "the intensity model is not downloaded yet".into())
}

fn sha256_matches(bytes: &[u8]) -> bool {
    format!("{:x}", Sha256::digest(bytes)) == SHA256
}

/// Make the model ready: the copy in `dir` if it is intact, else a download,
/// kept in `dir` for next time. Tries again every RETRY until it succeeds, so
/// a first launch offline gets the model once it is back online.
pub async fn prepare(dir: PathBuf, client: reqwest::Client) {
    let path = dir.join(FILE);
    loop {
        let bytes = match std::fs::read(&path) {
            Ok(b) if sha256_matches(&b) => Some(b),
            _ => download(&client, &path).await,
        };
        if let Some(bytes) = bytes {
            // ~420k tree nodes to parse and lay out: off the async workers.
            let built = tauri::async_runtime::spawn_blocking(move || {
                parse_model(&bytes).and_then(|g| compile(&g))
            })
            .await;
            match built {
                Ok(Ok(m)) => {
                    let _ = MODEL.set(m);
                    log::info!("ML 震度模型就緒");
                    return;
                }
                Ok(Err(e)) => log::error!("ML 震度模型無法使用，刪掉重下載：{e}"),
                Err(e) => log::error!("ML 震度模型建置失敗：{e}"),
            }
            let _ = std::fs::remove_file(&path);
        }
        tokio::time::sleep(RETRY).await;
    }
}

/// The first source that answers with the right file, written to `path`.
async fn download(client: &reqwest::Client, path: &Path) -> Option<Vec<u8>> {
    for url in SOURCES {
        let fetched = async {
            let res = client
                .get(url)
                .timeout(Duration::from_secs(300))
                .send()
                .await
                .map_err(|e| e.to_string())?;
            if !res.status().is_success() {
                return Err(format!("HTTP {}", res.status()));
            }
            res.bytes().await.map_err(|e| e.to_string())
        }
        .await;
        match fetched {
            Ok(bytes) if sha256_matches(&bytes) => {
                // Written beside and renamed, so an interrupted write never
                // leaves a partial file under the real name.
                let tmp = path.with_extension("part");
                let saved = std::fs::create_dir_all(path.parent().unwrap_or(Path::new(".")))
                    .and_then(|()| std::fs::write(&tmp, &bytes))
                    .and_then(|()| std::fs::rename(&tmp, path));
                if let Err(e) = saved {
                    log::warn!("ML 震度模型沒能存到磁碟，下次啟動會再下載：{e}");
                }
                log::info!(
                    "ML 震度模型下載完成：{url}（{}）",
                    crate::logging::fmt_bytes(bytes.len() as u64)
                );
                return Some(bytes.to_vec());
            }
            Ok(_) => log::warn!("{url} 下載的 ML 震度模型 SHA-256 不符，換下一個來源"),
            Err(e) => log::warn!("{url} 下載 ML 震度模型失敗，換下一個來源：{e}"),
        }
    }
    None
}

/// The feature row for one epicentre and target point, computed in f64 and
/// rounded to f32 exactly as the reference implementation (cwa-eew-web's
/// featRow) does, grouping included.
pub fn features(mag: f64, depth: f64, ev_lat: f64, ev_lon: f64, t_lat: f64, t_lon: f64) -> Row {
    let p1 = ev_lat * D2R;
    let p2 = t_lat * D2R;
    let dl = (t_lon - ev_lon) * D2R;
    let s1 = ((p2 - p1) / 2.0).sin();
    let s2 = (dl / 2.0).sin();
    let a = s1 * s1 + p1.cos() * p2.cos() * (s2 * s2);
    let dist = 2.0 * EARTH_KM * a.sqrt().asin();
    let ln_r = dist.hypot(depth).max(3.0).ln();
    let az = (dl.sin() * p2.cos()).atan2(p1.cos() * p2.sin() - p1.sin() * p2.cos() * dl.cos());
    [
        mag as f32,
        depth as f32,
        dist as f32,
        ln_r as f32,
        ev_lat as f32,
        ev_lon as f32,
        t_lat as f32,
        t_lon as f32,
        az.sin() as f32,
        az.cos() as f32,
    ]
}

/// CWA level (0-9) for a predicted PGA and PGV: the higher classification.
pub fn level(pga: f32, pgv: f32) -> u8 {
    let classify =
        |v: f32, bounds: &[f64; 9]| bounds.iter().filter(|&&b| f64::from(v) >= b).count();
    classify(pga, &PGA_BOUNDS).max(classify(pgv, &PGV_BOUNDS)) as u8
}

// ─── Minimal protobuf reader ────────────────────────────────────────────────
// Just enough of the wire format and the ONNX schema for this model; fields it
// does not use are skipped.

struct Field<'a> {
    num: u64,
    wire: u8,
    v: u64,
    b: &'a [u8],
}

fn fields<'a>(
    mut buf: &'a [u8],
    mut f: impl FnMut(Field<'a>) -> Result<(), String>,
) -> Result<(), String> {
    fn varint(buf: &mut &[u8]) -> Result<u64, String> {
        let mut v = 0u64;
        for shift in (0..64).step_by(7) {
            let (&b, rest) = buf.split_first().ok_or("onnx: truncated varint")?;
            *buf = rest;
            v |= u64::from(b & 0x7f) << shift;
            if b & 0x80 == 0 {
                return Ok(v);
            }
        }
        Err("onnx: varint too long".into())
    }
    fn take<'b>(buf: &mut &'b [u8], n: usize) -> Result<&'b [u8], String> {
        if buf.len() < n {
            return Err("onnx: truncated field".into());
        }
        let (head, rest) = buf.split_at(n);
        *buf = rest;
        Ok(head)
    }
    while !buf.is_empty() {
        let key = varint(&mut buf)?;
        let wire = (key & 7) as u8;
        let mut fld = Field {
            num: key >> 3,
            wire,
            v: 0,
            b: &[],
        };
        match wire {
            0 => fld.v = varint(&mut buf)?,
            1 => fld.v = u64::from_le_bytes(take(&mut buf, 8)?.try_into().unwrap()),
            2 => {
                let n = varint(&mut buf)? as usize;
                fld.b = take(&mut buf, n)?;
            }
            5 => fld.v = u64::from(u32::from_le_bytes(take(&mut buf, 4)?.try_into().unwrap())),
            w => return Err(format!("onnx: unsupported wire type {w}")),
        }
        f(fld)?;
    }
    Ok(())
}

fn push_floats(dst: &mut Vec<f32>, f: &Field) -> Result<(), String> {
    match f.wire {
        5 => dst.push(f32::from_bits(f.v as u32)),
        2 if f.b.len().is_multiple_of(4) => dst.extend(
            f.b.chunks_exact(4)
                .map(|c| f32::from_le_bytes(c.try_into().unwrap())),
        ),
        _ => return Err("onnx: malformed float field".into()),
    }
    Ok(())
}

fn push_ints(dst: &mut Vec<i64>, f: &Field) -> Result<(), String> {
    match f.wire {
        0 => dst.push(f.v as i64),
        2 => {
            let mut b = f.b;
            while !b.is_empty() {
                let mut v = 0u64;
                let mut shift = 0;
                loop {
                    let (&byte, rest) = b.split_first().ok_or("onnx: truncated packed int")?;
                    b = rest;
                    v |= u64::from(byte & 0x7f) << shift;
                    if byte & 0x80 == 0 {
                        break;
                    }
                    shift += 7;
                    if shift >= 64 {
                        return Err("onnx: packed int too long".into());
                    }
                }
                dst.push(v as i64);
            }
        }
        _ => return Err("onnx: malformed int field".into()),
    }
    Ok(())
}

fn utf8(b: &[u8]) -> Result<String, String> {
    String::from_utf8(b.to_vec()).map_err(|_| "onnx: invalid utf-8".to_string())
}

#[derive(Default)]
struct Attr {
    i: i64,
    s: String,
    floats: Vec<f32>,
    ints: Vec<i64>,
    strings: Vec<String>,
}

struct Node {
    op_type: String,
    domain: String,
    inputs: Vec<String>,
    outputs: Vec<String>,
    attrs: HashMap<String, Attr>,
}

#[derive(Default)]
struct Graph {
    nodes: Vec<Node>,
    floats: HashMap<String, Vec<f32>>,
    ints: HashMap<String, Vec<i64>>,
    inputs: Vec<String>,
}

fn parse_model(buf: &[u8]) -> Result<Graph, String> {
    let mut graph_bytes = None;
    fields(buf, |f| {
        if f.num == 7 && f.wire == 2 {
            graph_bytes = Some(f.b); // ModelProto.graph
        }
        Ok(())
    })?;
    let mut g = Graph::default();
    fields(graph_bytes.ok_or("onnx: model has no graph")?, |f| {
        match f.num {
            1 => g.nodes.push(parse_node(f.b)?),
            5 => parse_tensor(f.b, &mut g)?,
            11 => {
                let mut name = String::new();
                fields(f.b, |v| {
                    if v.num == 1 {
                        name = utf8(v.b)?;
                    }
                    Ok(())
                })?;
                g.inputs.push(name);
            }
            _ => {}
        }
        Ok(())
    })?;
    Ok(g)
}

fn parse_node(buf: &[u8]) -> Result<Node, String> {
    let mut n = Node {
        op_type: String::new(),
        domain: String::new(),
        inputs: vec![],
        outputs: vec![],
        attrs: HashMap::new(),
    };
    fields(buf, |f| {
        match f.num {
            1 => n.inputs.push(utf8(f.b)?),
            2 => n.outputs.push(utf8(f.b)?),
            4 => n.op_type = utf8(f.b)?,
            7 => n.domain = utf8(f.b)?,
            5 => {
                let mut name = String::new();
                let mut a = Attr::default();
                fields(f.b, |v| {
                    match v.num {
                        1 => name = utf8(v.b)?,
                        3 => a.i = v.v as i64,
                        4 => a.s = utf8(v.b)?,
                        7 => push_floats(&mut a.floats, &v)?,
                        8 => push_ints(&mut a.ints, &v)?,
                        9 => a.strings.push(utf8(v.b)?),
                        _ => {}
                    }
                    Ok(())
                })?;
                n.attrs.insert(name, a);
            }
            _ => {}
        }
        Ok(())
    })?;
    Ok(n)
}

fn parse_tensor(buf: &[u8], g: &mut Graph) -> Result<(), String> {
    let (mut name, mut dtype, mut raw) = (String::new(), 0u64, &[][..]);
    let (mut floats, mut ints) = (vec![], vec![]);
    fields(buf, |f| {
        match f.num {
            2 => dtype = f.v,
            4 => push_floats(&mut floats, &f)?,
            7 => push_ints(&mut ints, &f)?,
            8 => name = utf8(f.b)?,
            9 => raw = f.b,
            _ => {}
        }
        Ok(())
    })?;
    match dtype {
        1 => {
            floats.extend(
                raw.chunks_exact(4)
                    .map(|c| f32::from_le_bytes(c.try_into().unwrap())),
            );
            g.floats.insert(name, floats);
        }
        7 => {
            ints.extend(
                raw.chunks_exact(8)
                    .map(|c| i64::from_le_bytes(c.try_into().unwrap())),
            );
            g.ints.insert(name, ints);
        }
        t => {
            return Err(format!(
                "onnx: initializer {name:?} has unsupported type {t}"
            ))
        }
    }
    Ok(())
}

// ─── Compiled graph ─────────────────────────────────────────────────────────

/// Where an op reads a value: a broadcast constant or a column of the batch.
#[derive(Clone, Copy)]
enum Arg {
    Const(f32),
    Col(usize),
}

enum Op {
    Gather { feat: usize },
    Add(Arg, Arg),
    Mul(Arg, Arg),
    Exp(Arg),
    Copy(Arg),
    Trees(Forest),
}

struct Step {
    op: Op,
    out: usize,
}

pub struct Model {
    steps: Vec<Step>,
    n_cols: usize,
    pga: usize,
    pgv: usize,
}

fn compile(g: &Graph) -> Result<Model, String> {
    let [input] = g.inputs.as_slice() else {
        return Err(format!("onnx: want 1 graph input, have {}", g.inputs.len()));
    };
    let mut cols: HashMap<&str, usize> = HashMap::new();
    let mut steps = vec![];
    let arg = |cols: &HashMap<&str, usize>, name: &str| -> Result<Arg, String> {
        if let Some(&c) = cols.get(name) {
            return Ok(Arg::Col(c));
        }
        match g.floats.get(name).map(Vec::as_slice) {
            Some(&[v]) => Ok(Arg::Const(v)),
            Some(v) => Err(format!(
                "onnx: constant {name:?} has {} elements, want 1",
                v.len()
            )),
            None => Err(format!("onnx: {name:?} is read before it is produced")),
        }
    };
    for n in &g.nodes {
        let [out] = n.outputs.as_slice() else {
            return Err(format!(
                "onnx: {} has {} outputs, want 1",
                n.op_type,
                n.outputs.len()
            ));
        };
        let input_at = |i: usize| {
            n.inputs
                .get(i)
                .map(String::as_str)
                .ok_or_else(|| format!("onnx: {} is missing input {i}", n.op_type))
        };
        let op = match (n.domain.as_str(), n.op_type.as_str()) {
            ("", "Gather") => {
                let axis = n.attrs.get("axis").map_or(0, |a| a.i);
                if input_at(0)? != input || axis != 1 {
                    return Err(format!("onnx: only Gather({input}, axis=1) is supported"));
                }
                match g.ints.get(input_at(1)?).map(Vec::as_slice) {
                    Some(&[i]) if (0..N_FEAT as i64).contains(&i) => {
                        Op::Gather { feat: i as usize }
                    }
                    idx => return Err(format!("onnx: Gather index {idx:?} out of range")),
                }
            }
            ("", "Add") => Op::Add(arg(&cols, input_at(0)?)?, arg(&cols, input_at(1)?)?),
            ("", "Mul") => Op::Mul(arg(&cols, input_at(0)?)?, arg(&cols, input_at(1)?)?),
            ("", "Exp") => Op::Exp(arg(&cols, input_at(0)?)?),
            ("", "Identity") => Op::Copy(arg(&cols, input_at(0)?)?),
            ("ai.onnx.ml", "TreeEnsembleRegressor") => {
                if input_at(0)? != input {
                    return Err(format!("onnx: trees must read the graph input {input:?}"));
                }
                Op::Trees(Forest::compile(&n.attrs)?)
            }
            (d, o) => return Err(format!("onnx: unsupported op {d}/{o}")),
        };
        let col = cols.len();
        cols.insert(out.as_str(), col);
        steps.push(Step { op, out: col });
    }
    let (Some(&pga), Some(&pgv)) = (cols.get("PGA"), cols.get("PGV")) else {
        return Err("onnx: graph must compute PGA and PGV".into());
    };
    Ok(Model {
        steps,
        n_cols: cols.len(),
        pga,
        pgv,
    })
}

impl Model {
    /// PGA (gal) and PGV (cm/s) for every row. Large batches are split across
    /// threads by row; each row's arithmetic is unchanged by the split.
    pub fn predict(&self, rows: &[Row]) -> (Vec<f32>, Vec<f32>) {
        let mut pga = vec![0.0; rows.len()];
        let mut pgv = vec![0.0; rows.len()];
        let threads = std::thread::available_parallelism().map_or(1, usize::from);
        let workers = threads.min(rows.len() / MIN_ROWS_PER_WORKER).max(1);
        if workers == 1 {
            self.run(rows, &mut pga, &mut pgv);
            return (pga, pgv);
        }
        let chunk = rows.len().div_ceil(workers);
        std::thread::scope(|s| {
            for ((r, a), v) in rows
                .chunks(chunk)
                .zip(pga.chunks_mut(chunk))
                .zip(pgv.chunks_mut(chunk))
            {
                s.spawn(move || self.run(r, a, v));
            }
        });
        (pga, pgv)
    }

    fn run(&self, rows: &[Row], pga: &mut [f32], pgv: &mut [f32]) {
        let n = rows.len();
        let mut cols: Vec<Vec<f32>> = vec![Vec::new(); self.n_cols];
        for s in &self.steps {
            let get = |cols: &Vec<Vec<f32>>, a: Arg, i: usize| match a {
                Arg::Const(v) => v,
                Arg::Col(c) => cols[c][i],
            };
            let out: Vec<f32> = match &s.op {
                Op::Gather { feat } => rows.iter().map(|r| r[*feat]).collect(),
                Op::Add(a, b) => (0..n)
                    .map(|i| get(&cols, *a, i) + get(&cols, *b, i))
                    .collect(),
                Op::Mul(a, b) => (0..n)
                    .map(|i| get(&cols, *a, i) * get(&cols, *b, i))
                    .collect(),
                Op::Exp(a) => (0..n).map(|i| mlas_exp(get(&cols, *a, i))).collect(),
                Op::Copy(a) => (0..n).map(|i| get(&cols, *a, i)).collect(),
                Op::Trees(f) => f.eval(rows),
            };
            cols[s.out] = out;
        }
        pga.copy_from_slice(&cols[self.pga]);
        pgv.copy_from_slice(&cols[self.pgv]);
    }
}

// ─── Tree ensembles ─────────────────────────────────────────────────────────

/// A compiled `ai.onnx.ml` TreeEnsembleRegressor (one target, SUM, no post
/// transform), laid out for speed: each branch's children sit side by side
/// (true first) and every test is "go right when x > thr", so a step is
/// `child + (x > thr)` with no branch to mispredict. Leaves point at
/// themselves with thr = +inf, so a tree is walked a fixed number of steps.
struct Forest {
    nodes: Vec<TreeNode>,
    /// Leaf weight by node index; 0 for branches.
    values: Vec<f32>,
    roots: Vec<u32>,
    depths: Vec<u8>,
    base: f32,
}

struct TreeNode {
    thr: f32,
    feat: u32,
    child: u32,
}

impl Forest {
    fn compile(attrs: &HashMap<String, Attr>) -> Result<Forest, String> {
        let empty = Attr::default();
        let get = |k: &str| attrs.get(k).unwrap_or(&empty);
        if get("n_targets").i != 1 {
            return Err(format!(
                "onnx: trees: n_targets {}, want 1",
                get("n_targets").i
            ));
        }
        for (k, ok) in [("post_transform", "NONE"), ("aggregate_function", "SUM")] {
            let v = &get(k).s;
            if !v.is_empty() && v != ok {
                return Err(format!("onnx: trees: {k} {v} not supported"));
            }
        }
        let tree = &get("nodes_treeids").ints;
        let node = &get("nodes_nodeids").ints;
        let feat = &get("nodes_featureids").ints;
        let mode = &get("nodes_modes").strings;
        let thr = &get("nodes_values").floats;
        let yes = &get("nodes_truenodeids").ints;
        let no = &get("nodes_falsenodeids").ints;
        let n = tree.len();
        if n == 0
            || [
                node.len(),
                feat.len(),
                mode.len(),
                thr.len(),
                yes.len(),
                no.len(),
            ]
            .iter()
            .any(|&l| l != n)
        {
            return Err("onnx: trees: node attribute lengths disagree".into());
        }
        let index: HashMap<(i64, i64), usize> = (0..n).map(|i| ((tree[i], node[i]), i)).collect();

        let (tt, tn) = (&get("target_treeids").ints, &get("target_nodeids").ints);
        let (tid, tw) = (&get("target_ids").ints, &get("target_weights").floats);
        if tn.len() != tt.len() || tid.len() != tt.len() || tw.len() != tt.len() {
            return Err("onnx: trees: target attribute lengths disagree".into());
        }
        let mut weight: HashMap<(i64, i64), f32> = HashMap::with_capacity(tt.len());
        for i in 0..tt.len() {
            if tid[i] != 0 {
                return Err(format!("onnx: trees: target id {}, want 0", tid[i]));
            }
            if weight.insert((tt[i], tn[i]), tw[i]).is_some() {
                return Err(format!(
                    "onnx: trees: leaf {:?} has more than one weight",
                    (tt[i], tn[i])
                ));
            }
        }

        let mut f = Forest {
            nodes: Vec::with_capacity(n),
            values: Vec::with_capacity(n),
            roots: vec![],
            depths: vec![],
            base: get("base_values").floats.first().copied().unwrap_or(0.0),
        };
        // Summed in ascending tree id, the order onnxruntime uses.
        let mut trees: Vec<i64> = (0..n).filter(|&i| node[i] == 0).map(|i| tree[i]).collect();
        trees.sort_unstable();
        for t in trees {
            let root = f.push();
            // Explicit stack instead of recursion: (onnx node, slot, depth).
            let mut stack = vec![(index[&(t, 0)], root, 0usize)];
            let mut depth = 0usize;
            while let Some((i, slot, d)) = stack.pop() {
                if d > u8::MAX as usize {
                    return Err(format!("onnx: trees: tree {t} too deep"));
                }
                match mode[i].as_str() {
                    "LEAF" => {
                        f.nodes[slot] = TreeNode {
                            thr: f32::INFINITY,
                            feat: 0,
                            child: slot as u32,
                        };
                        f.values[slot] = weight.get(&(t, node[i])).copied().unwrap_or(0.0);
                        depth = depth.max(d);
                        continue;
                    }
                    "BRANCH_LEQ" | "BRANCH_LT" => {}
                    m => return Err(format!("onnx: trees: node mode {m} not supported")),
                }
                if !(0..N_FEAT as i64).contains(&feat[i]) {
                    return Err(format!("onnx: trees: feature {} out of range", feat[i]));
                }
                // x < t is x <= the f32 just below t, for every finite x, so
                // both modes share one comparison.
                let th = if mode[i] == "BRANCH_LT" {
                    next_down(thr[i])
                } else {
                    thr[i]
                };
                let (Some(&ti), Some(&fi)) = (index.get(&(t, yes[i])), index.get(&(t, no[i])))
                else {
                    return Err(format!("onnx: trees: tree {t} has a dangling child"));
                };
                let child = f.push();
                f.push();
                f.nodes[slot] = TreeNode {
                    thr: th,
                    feat: feat[i] as u32,
                    child: child as u32,
                };
                stack.push((fi, child + 1, d + 1));
                stack.push((ti, child, d + 1));
            }
            f.roots.push(root as u32);
            f.depths.push(depth as u8);
        }
        Ok(f)
    }

    fn push(&mut self) -> usize {
        self.nodes.push(TreeNode {
            thr: 0.0,
            feat: 0,
            child: 0,
        });
        self.values.push(0.0);
        self.nodes.len() - 1
    }

    /// Ensemble output per row. Tree-major, so a tree stays in cache across the
    /// batch, and eight rows advance in lockstep so their independent load /
    /// compare chains overlap. Inputs must be finite: a NaN would take the
    /// false branch where ONNX's missing-value rule might not.
    fn eval(&self, rows: &[Row]) -> Vec<f32> {
        let mut out = vec![0.0f32; rows.len()];
        let nodes = &self.nodes;
        let step = |n: u32, r: &Row| {
            let x = &nodes[n as usize];
            x.child + u32::from(r[x.feat as usize] > x.thr)
        };
        for (&root, &depth) in self.roots.iter().zip(&self.depths) {
            let mut chunks = rows.chunks_exact(8);
            let mut o = out.chunks_exact_mut(8);
            for (r, o) in (&mut chunks).zip(&mut o) {
                let mut n = [root; 8];
                for _ in 0..depth {
                    for k in 0..8 {
                        n[k] = step(n[k], &r[k]);
                    }
                }
                for k in 0..8 {
                    o[k] += self.values[n[k] as usize];
                }
            }
            for (r, o) in chunks.remainder().iter().zip(o.into_remainder()) {
                let mut n = root;
                for _ in 0..depth {
                    n = step(n, r);
                }
                *o += self.values[n as usize];
            }
        }
        for o in &mut out {
            *o += self.base;
        }
        out
    }
}

/// The next f32 toward -inf (finite, non-NaN input).
fn next_down(x: f32) -> f32 {
    if x == 0.0 {
        return -f32::from_bits(1);
    }
    let b = x.to_bits();
    f32::from_bits(if x > 0.0 { b - 1 } else { b + 1 })
}

/// onnxruntime's f32 Exp: MLAS `MlasComputeExpF32Kernel`
/// (onnxruntime/core/mlas/lib/compute.cpp), constants and operation order as
/// there, every multiply-add fused as the kernel's `MlasMultiplyAddFloat32x4`
/// is. A correctly rounded exp differs from it by an ulp on ~7% of inputs,
/// which the PGV formula's `cRlin·exp(lnR)` term then amplifies.
#[allow(clippy::excessive_precision)]
fn mlas_exp(x: f32) -> f32 {
    // Written as in MLAS so they round to the same f32.
    const LOWER: f32 = -103.9720840454;
    const UPPER: f32 = 88.7762626647950;
    const ROUNDING_BIAS: f32 = 12_582_912.0; // 1.5·2^23
                                             // MLAS's 1.44269504088896341 rounds to exactly this f32.
    const LOG2_RECIP: f32 = std::f32::consts::LOG2_E;
    const LOG2_HIGH: f32 = -6.93145752e-1;
    const LOG2_LOW: f32 = -1.42860677e-6;
    // MLAS gives these as hex floats, which Rust has no literal for.
    const POLY: [f32; 6] = [
        f32::from_bits(0x3AB4_A000), // 0x1.694000p-10
        f32::from_bits(0x3C09_2F6E), // 0x1.125edcp-7
        f32::from_bits(0x3D2A_ADAD), // 0x1.555b5ap-5
        f32::from_bits(0x3E2A_AA28), // 0x1.555450p-3
        f32::from_bits(0x3EFF_FFFB), // 0x1.fffff6p-2
        1.0,
    ];
    const MIN_EXPONENT: i32 = 0xC100_0000_u32 as i32;
    const MAX_EXPONENT: i32 = 0x3F80_0000;

    let x = x.clamp(LOWER, UPPER);
    let biased = x.mul_add(LOG2_RECIP, ROUNDING_BIAS);
    let m = biased - ROUNDING_BIAS;
    let x = m.mul_add(LOG2_HIGH, x);
    let x = m.mul_add(LOG2_LOW, x);
    let shifted = (biased.to_bits() << 23) as i32;
    let normal = shifted.clamp(MIN_EXPONENT, MAX_EXPONENT);
    let overflow = shifted.wrapping_sub(normal).wrapping_add(MAX_EXPONENT);
    let normal = normal.wrapping_add(MAX_EXPONENT);
    let mut p = POLY[0];
    for &c in &POLY[1..] {
        p = p.mul_add(x, c);
    }
    let of = f32::from_bits(overflow as u32);
    let x = x * of;
    let p = p.mul_add(x, of);
    p * f32::from_bits(normal as u32)
}

/// Tests read the repository's copy instead of downloading it.
#[cfg(test)]
pub fn load_for_tests() -> &'static Model {
    const ONNX: &[u8] =
        include_bytes!("../../../../packages/core/static/models/intensity_ml_v1.onnx");
    assert!(sha256_matches(ONNX), "the model in the repository changed");
    MODEL.get_or_init(|| parse_model(ONNX).and_then(|g| compile(&g)).unwrap())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// onnxruntime's own output for the embedded model
    /// (testdata/ml_intensity_golden.py, single-threaded).
    #[derive(serde::Deserialize)]
    struct Case {
        mag: f64,
        depth: f64,
        ev_lat: f64,
        ev_lon: f64,
        t_lat: f64,
        t_lon: f64,
        features: [f64; N_FEAT],
        pga: f64,
        pgv: f64,
        level: u8,
    }
    #[derive(serde::Deserialize)]
    struct Golden {
        cases: Vec<Case>,
    }

    fn golden() -> Golden {
        let g: Golden =
            serde_json::from_str(include_str!("../testdata/ml_intensity_golden.json")).unwrap();
        assert!(!g.cases.is_empty());
        g
    }

    #[test]
    fn model_compiles_to_four_ensembles() {
        let m = load_for_tests();
        let forests: Vec<&Forest> = m
            .steps
            .iter()
            .filter_map(|s| {
                if let Op::Trees(f) = &s.op {
                    Some(f)
                } else {
                    None
                }
            })
            .collect();
        assert_eq!(forests.len(), 4);
        assert!(forests.iter().all(|f| f.roots.len() == 700));
    }

    /// Fed onnxruntime's exact input rows, PGA and PGV must match to the bit.
    #[test]
    fn bit_identical_to_onnxruntime() {
        let g = golden();
        let rows: Vec<Row> = g
            .cases
            .iter()
            .map(|c| c.features.map(|v| v as f32))
            .collect();
        let (pga, pgv) = load_for_tests().predict(&rows);
        for (i, c) in g.cases.iter().enumerate() {
            assert_eq!(
                pga[i].to_bits(),
                (c.pga as f32).to_bits(),
                "case {i} PGA {} vs {}",
                pga[i],
                c.pga
            );
            assert_eq!(
                pgv[i].to_bits(),
                (c.pgv as f32).to_bits(),
                "case {i} PGV {} vs {}",
                pgv[i],
                c.pgv
            );
            assert_eq!(level(pga[i], pgv[i]), c.level, "case {i}");
        }
    }

    /// The feature row against the reference construction. Platform libm can
    /// round the last f64 bit of sin/asin/hypot differently, which can move an
    /// f32 feature by at most one ulp; the levels must still agree.
    #[test]
    fn features_match_reference() {
        let g = golden();
        let rows: Vec<Row> = g
            .cases
            .iter()
            .map(|c| features(c.mag, c.depth, c.ev_lat, c.ev_lon, c.t_lat, c.t_lon))
            .collect();
        for (i, c) in g.cases.iter().enumerate() {
            for (j, &want) in c.features.iter().enumerate() {
                let d = (rows[i][j].to_bits() as i64 - (want as f32).to_bits() as i64).abs();
                assert!(d <= 1, "case {i} feature {j}: {} vs {}", rows[i][j], want);
            }
        }
        let (pga, pgv) = load_for_tests().predict(&rows);
        for (i, c) in g.cases.iter().enumerate() {
            assert_eq!(level(pga[i], pgv[i]), c.level, "case {i}");
        }
    }

    /// Splitting a batch across threads changes no bit of any row.
    #[test]
    fn thread_split_is_deterministic() {
        let g = golden();
        let rows: Vec<Row> = g
            .cases
            .iter()
            .cycle()
            .take(2000)
            .map(|c| c.features.map(|v| v as f32))
            .collect();
        let m = load_for_tests();
        let (pa, pv) = m.predict(&rows);
        let (mut sa, mut sv) = (vec![0.0; rows.len()], vec![0.0; rows.len()]);
        m.run(&rows, &mut sa, &mut sv);
        assert!(pa.iter().zip(&sa).all(|(a, b)| a.to_bits() == b.to_bits()));
        assert!(pv.iter().zip(&sv).all(|(a, b)| a.to_bits() == b.to_bits()));
    }

    #[test]
    fn level_bounds() {
        // Reached AT the bound, compared in f64 like the reference: f32(5.7)
        // rounds just below 5.7 and so stays level 3.
        for (pga, pgv, want) in [
            (0.0, 0.0, 0),
            (0.8, 0.0, 1),
            (0.0, 0.2, 1),
            (25.0, 0.0, 4),
            (0.0, 5.7, 3),
            (0.0, 5.71, 4),
            (80.0, 0.0, 5),
            (0.0, 30.0, 6),
            (250.0, 0.0, 7),
            (0.0, 80.0, 8),
            (800.0, 0.0, 9),
        ] {
            assert_eq!(level(pga, pgv), want, "level({pga}, {pgv})");
        }
    }
}
