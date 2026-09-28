/**
 * Regional routing for the web build — what `apps/desktop/src-tauri/src/
 * endpoints.rs` does for the desktop app inside the Rust proxy. The two tables
 * must agree.
 *
 * Every ExpTech service is published under a DNS-balanced name and once per
 * region. The app writes the balanced name and this swaps in the pool's active
 * regional node, so DNS never picks the region: it decides afresh on every
 * lookup, and two requests a second apart could reach regions whose data
 * disagree — the "phantom drift" that once showed two different sets of
 * reports. The active node moves only when it fails a probe, fails three
 * requests in a row, or another node has become at least twice as fast.
 */
import { createLogger } from "@/lib/logger";

interface Service {
  /** The DNS-balanced name the app writes. */
  balanced: string;
  /** One name per region, the nearest first: it answers until probed. */
  nodes: readonly string[];
  /** A small path every node serves. HEAD where the body is not small. */
  probe: string;
  head: boolean;
}

const SERVICES: readonly Service[] = [
  {
    balanced: "api.lb.exptech.dev",
    nodes: ["api.lb-tpe1.exptech.dev", "api.lb-khh1.exptech.dev"],
    probe: "/api/v2/eq/eew",
    head: false,
  },
  {
    balanced: "static.lb.exptech.dev",
    nodes: ["static.lb-tpe1.exptech.dev", "static.lb-khh1.exptech.dev"],
    probe: "/api/v1/map/tiles/0/0/0.pbf",
    head: true,
  },
  {
    balanced: "api.core.exptech.dev",
    nodes: ["api.core-tnn1.exptech.dev", "api.core-tyo1.exptech.dev"],
    probe: "/api/v2/eq/eew",
    head: false,
  },
  {
    balanced: "static.core.exptech.dev",
    nodes: ["static.core-tnn1.exptech.dev", "static.core-tyo1.exptech.dev"],
    probe: "/resource/station",
    head: true,
  },
];

const PROBE_EVERY = 30_000;
const PROBE_TIMEOUT = 4_000;
/** Requests failed in a row before a node is taken out. */
const FAILOVER_AFTER = 3;
/** Weight of a new probe in the smoothed latency. */
const SMOOTHING = 0.3;

interface Node {
  host: string;
  healthy: boolean;
  /** Smoothed probe round trip in ms; null until a probe has answered. */
  latency: number | null;
  failures: number;
}

interface Pool {
  service: Service;
  nodes: Node[];
  active: number;
}

/** One node of one pool. */
export interface Target {
  pool: Pool;
  node: number;
}

/** A request's URL as it will be sent, and the node it goes to if routed. */
export interface Route {
  url: string;
  target: Target | null;
}

const log = createLogger("endpoints");

const pools: Pool[] = SERVICES.map((service) => ({
  service,
  nodes: service.nodes.map((host) => ({ host, healthy: true, latency: null, failures: 0 })),
  active: 0,
}));

/** The fastest healthy node other than `except`; unmeasured ranks last. */
function fastest(pool: Pool, except: number | null): number | null {
  let best: number | null = null;
  pool.nodes.forEach((n, i) => {
    if (i === except || !n.healthy) return;
    if (best === null || (n.latency ?? Infinity) < (pool.nodes[best].latency ?? Infinity)) best = i;
  });
  return best;
}

function reselect(pool: Pool): void {
  const current = pool.nodes[pool.active];
  const other = fastest(pool, pool.active);
  if (other === null) return;
  const there = pool.nodes[other].latency;
  const move =
    !current.healthy ||
    (there !== null && (current.latency === null || there * 2 <= current.latency));
  if (!move) return;
  log.info(`換節點：${pool.service.balanced} 從 ${current.host} 改走 ${pool.nodes[other].host}`);
  pool.active = other;
}

function at(url: URL, host: string): string {
  const copy = new URL(url);
  copy.host = host;
  return copy.toString();
}

/** A balanced name swapped for its pool's active node; anything else as is. */
export function route(url: string): Route {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { url, target: null }; // a same-origin asset path
  }
  const pool = pools.find((p) => p.service.balanced === parsed.host);
  if (!pool) return { url, target: null };
  startProbing();
  return { url: at(parsed, pool.nodes[pool.active].host), target: { pool, node: pool.active } };
}

/**
 * Where to try again after `failed` did not answer: the fastest other healthy
 * node, or null — retrying one known to be down would only double the wait.
 */
export function alternative(failed: Route): Route | null {
  if (!failed.target) return null;
  const { pool, node } = failed.target;
  const next = fastest(pool, node);
  if (next === null) return null;
  return { url: at(new URL(failed.url), pool.nodes[next].host), target: { pool, node: next } };
}

/** A real request's outcome. Only a probe brings a node back. */
export function report(target: Target, ok: boolean): void {
  const n = target.pool.nodes[target.node];
  if (ok) {
    n.failures = 0;
    return;
  }
  n.failures += 1;
  if (n.failures >= FAILOVER_AFTER && n.healthy) {
    log.warn(`${n.host} 連續 ${FAILOVER_AFTER} 個請求失敗，標為不健康`);
    n.healthy = false;
    n.latency = null;
  }
  reselect(target.pool);
}

async function probe(service: Service, host: string): Promise<number | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT);
  const start = performance.now();
  try {
    const res = await fetch(`https://${host}${service.probe}`, {
      method: service.head ? "HEAD" : "GET",
      cache: "no-store",
      signal: controller.signal,
    });
    if (!res.ok) return null;
    await res.arrayBuffer();
    return performance.now() - start;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function probeAll(): Promise<void> {
  await Promise.all(
    pools.flatMap((pool) =>
      pool.nodes.map(async (n) => {
        const rtt = await probe(pool.service, n.host);
        if (rtt === null) {
          if (n.healthy) log.warn(`${n.host} 探測失敗，標為不健康`);
          n.healthy = false;
          n.latency = null;
          return;
        }
        if (!n.healthy) log.info(`${n.host} 恢復（探測 ${Math.round(rtt)}ms）`);
        n.healthy = true;
        n.failures = 0;
        n.latency = n.latency === null ? rtt : n.latency + SMOOTHING * (rtt - n.latency);
      }),
    ),
  );
  pools.forEach(reselect);
}

let probing = false;

/** Probes every node now, then every 30 s — from the first routed request. */
function startProbing(): void {
  if (probing) return;
  probing = true;
  void probeAll();
  setInterval(() => void probeAll(), PROBE_EVERY);
}
