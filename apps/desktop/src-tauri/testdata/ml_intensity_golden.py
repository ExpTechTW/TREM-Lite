"""Regenerate ml_intensity_golden.json from onnxruntime.

src/ml_intensity.rs executes packages/core/src/data/intensity_ml_v1.onnx
natively; this records what onnxruntime itself answers for the same inputs, so
the Rust tests hold the port to the reference runtime rather than to itself.
Only needed when the model file changes:

    pip install onnxruntime numpy
    python apps/desktop/src-tauri/testdata/ml_intensity_golden.py
"""

import json
import math
import os
import random

import numpy as np
import onnxruntime as ort

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "..", "..", "..", "..", "packages", "core", "src", "data")
MODEL = os.path.join(DATA, "intensity_ml_v1.onnx")
REGION = os.path.join(DATA, "region.json")
OUT = os.path.join(HERE, "ml_intensity_golden.json")

PGA_B = [0.8, 2.5, 8, 25, 80, 140, 250, 440, 800]
PGV_B = [0.2, 0.7, 1.9, 5.7, 15, 30, 50, 80, 140]


# Feature row exactly as cwa-eew-web's featRow builds it.
def features(M, depth, ev_lat, ev_lon, t_lat, t_lon):
    p1, p2 = math.radians(ev_lat), math.radians(t_lat)
    dl = math.radians(t_lon - ev_lon)
    a = math.sin((p2 - p1) / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    dist = 2 * 6371.0 * math.asin(math.sqrt(a))
    lnR = math.log(max(math.hypot(dist, depth), 3.0))
    az = math.atan2(math.sin(dl) * math.cos(p2),
                    math.cos(p1) * math.sin(p2) - math.sin(p1) * math.cos(p2) * math.cos(dl))
    return [M, depth, dist, lnR, ev_lat, ev_lon, t_lat, t_lon, math.sin(az), math.cos(az)]


def level(pga, pgv):
    cls = lambda v, b: sum(1 for x in b if float(v) >= x)
    return max(cls(pga, PGA_B), cls(pgv, PGV_B))


def main():
    opts = ort.SessionOptions()
    opts.intra_op_num_threads = 1  # fixed summation order, reproducible output
    sess = ort.InferenceSession(MODEL, opts, providers=["CPUExecutionProvider"])
    run = lambda X: [o.ravel() for o in sess.run(None, {"features": np.asarray(X, np.float32)})]

    region = json.load(open(REGION, encoding="utf-8"))
    towns = sorted((t["code"], t["lat"], t["lon"]) for c in region.values() for t in c.values())

    # Random events around Taiwan, from barely felt to beyond the training
    # range, against town reference points and arbitrary points alike.
    rnd = random.Random(20260928)
    params = [(7.2, 30, 23.77, 121.67, 25.03, 121.56),  # model card: Taipei
              (7.2, 30, 23.77, 121.67, 23.87, 121.51)]  # model card: Shoufeng
    while len(params) < 600:
        M = round(rnd.uniform(2.5, 8.0), 1)
        depth = rnd.choice([5, 10, 15, 20, 30, 50, 80, 120, 150])
        ev = (round(rnd.uniform(21.5, 25.8), 2), round(rnd.uniform(119.5, 122.8), 2))
        if rnd.random() < 0.7:
            _, t_lat, t_lon = rnd.choice(towns)
        else:
            t_lat, t_lon = round(rnd.uniform(21.9, 25.3), 3), round(rnd.uniform(120.0, 122.0), 3)
        params.append((M, depth, *ev, t_lat, t_lon))
    X = np.array([features(*p) for p in params], np.float32)
    pga, pgv = run(X)
    cases = [{
        "mag": p[0], "depth": p[1], "ev_lat": p[2], "ev_lon": p[3], "t_lat": p[4], "t_lon": p[5],
        "features": [float(v) for v in x],
        "pga": float(a), "pgv": float(v), "level": level(a, v),
    } for p, x, a, v in zip(params, X, pga, pgv)]

    # Whole town tables, so the per-town map is pinned as well as the maximum.
    fields = []
    for lat, lon, M, depth in [(24.32, 121.8, 4.5, 10), (23.77, 121.67, 7.2, 30), (22.9, 120.3, 5.6, 15)]:
        Xf = np.array([features(M, depth, lat, lon, t_lat, t_lon) for _, t_lat, t_lon in towns], np.float32)
        fa, fv = run(Xf)
        fields.append({"lat": lat, "lon": lon, "mag": M, "depth": depth,
                       "levels": {str(c): level(a, v) for (c, _, _), a, v in zip(towns, fa, fv)}})

    with open(OUT, "w", encoding="utf-8") as f:
        json.dump({"onnxruntime": ort.__version__, "cases": cases, "fields": fields}, f, separators=(",", ":"))
    print(f"wrote {OUT}: {len(cases)} cases, {len(fields)} fields")
    os._exit(0)  # onnxruntime can abort in its own teardown on macOS


if __name__ == "__main__":
    main()
