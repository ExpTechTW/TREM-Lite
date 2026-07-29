/**
 * Endpoint health manager — pins each service to a SPECIFIC regional node and
 * fails over by health, instead of relying on the DNS-load-balanced base domains
 * (api.lb / api.core), whose "phantom drift" between regions caused inconsistent
 * report sets. Each pool is latency-probed periodically; the active node is the
 * lowest-latency healthy one, and consecutive request failures trigger failover.
 */
import { appFetch } from "@/lib/env";
import { createLogger } from "@/lib/logger";

export type PoolName = "lbApi" | "coreApi";

interface Node {
  host: string;
  ok: boolean;
  latency: number; // ms; Infinity when down
  failures: number; // consecutive request failures (passive)
}

interface Pool {
  probe: (host: string) => string;
  method: "GET" | "HEAD";
  nodes: Node[];
  active: number;
}

const mk = (host: string): Node => ({ host, ok: true, latency: Infinity, failures: 0 });

const FAILOVER_THRESHOLD = 3;
const PROBE_INTERVAL = 30_000;
const PROBE_TIMEOUT = 4_000;

const POOLS: Record<PoolName, Pool> = {
  // rts / eew SSE + polling
  lbApi: {
    probe: (h) => `https://${h}/api/v2/eq/eew`,
    method: "GET",
    nodes: [mk("api.lb-tpe1.exptech.dev"), mk("api.lb-khh1.exptech.dev")],
    active: 0,
  },
  // earthquake reports
  coreApi: {
    probe: (h) => `https://${h}/api/v2/eq/report?limit=1`,
    method: "GET",
    nodes: [mk("api.core-tyo1.exptech.dev"), mk("api.core-tnn1.exptech.dev")],
    active: 0,
  },
};

const log = createLogger("health");

/** Current active host for a service pool. */
export function getHost(pool: PoolName): string {
  const p = POOLS[pool];
  return p.nodes[p.active].host;
}

/** Full URL on the active host of a pool. */
export function url(pool: PoolName, path: string): string {
  return `https://${getHost(pool)}${path}`;
}

/** Pick the lowest-latency healthy node; keep the current one on ties/if healthy. */
function reselect(pool: PoolName): void {
  const p = POOLS[pool];
  let best = -1;
  let bestLatency = Infinity;
  p.nodes.forEach((n, i) => {
    if (n.ok && n.latency < bestLatency) {
      bestLatency = n.latency;
      best = i;
    }
  });
  if (best === -1) {
    // all unhealthy — keep going with the least-failed node so we still try
    best = p.nodes.reduce((a, n, i) => (n.failures < p.nodes[a].failures ? i : a), 0);
  }
  if (best !== p.active) {
    log.info(`${pool}: ${p.nodes[p.active].host} → ${p.nodes[best].host}`);
    p.active = best;
  }
}

/** Passive signal from real requests; failover after repeated failures. */
export function reportSuccess(pool: PoolName): void {
  POOLS[pool].nodes[POOLS[pool].active].failures = 0;
}
export function reportFailure(pool: PoolName): void {
  const p = POOLS[pool];
  const node = p.nodes[p.active];
  node.failures += 1;
  if (node.failures >= FAILOVER_THRESHOLD) {
    node.ok = false;
    node.latency = Infinity;
    reselect(pool);
  }
}

async function probeNode(pool: Pool, node: Node): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT);
  const start = Date.now();
  try {
    const res = await appFetch(pool.probe(node.host), {
      method: pool.method,
      signal: controller.signal,
      headers: { "Cache-Control": "no-cache" },
    });
    node.ok = res.ok;
    node.latency = res.ok ? Date.now() - start : Infinity;
    if (res.ok) node.failures = 0;
  } catch {
    node.ok = false;
    node.latency = Infinity;
  } finally {
    clearTimeout(timer);
  }
}

async function checkPool(name: PoolName): Promise<void> {
  const p = POOLS[name];
  await Promise.all(p.nodes.map((n) => probeNode(p, n)));
  reselect(name);
}

let started = false;

/** Probe all pools now and every 30s. Idempotent. */
export function initHealth(): void {
  if (started) return;
  started = true;
  const all = () => (Object.keys(POOLS) as PoolName[]).forEach((n) => void checkPool(n));
  all();
  setInterval(all, PROBE_INTERVAL);
}
