/**
 * The ExpTech services, by their DNS-balanced names — the only names the app
 * writes, and never the ones contacted. The HTTP layer sends each request to a
 * healthy regional node of the same service instead: the Rust proxy on
 * desktop (`apps/desktop/src-tauri/src/endpoints.rs`), `lib/http/regions.ts`
 * on the web. Letting DNS pick the region per lookup is what once caused the
 * "phantom drift" between two regions' report sets.
 */
export const HOST = {
  lbApi: "api.lb.exptech.dev",
  lbStatic: "static.lb.exptech.dev",
  coreApi: "api.core.exptech.dev",
  coreStatic: "static.core.exptech.dev",
} as const;

/**
 * The realtime API's host: the balanced LB name, routed to a healthy regional
 * node like any other. (It was once a setting, 設定 → API 代理網域; the
 * regional failover made it redundant, and any host outside ExpTech's broke
 * the realtime data, the proxy only speaking to ExpTech.)
 */
export function lbApiHost(): string {
  return HOST.lbApi;
}
