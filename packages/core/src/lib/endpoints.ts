/**
 * The ExpTech services, by their DNS-balanced names — the only names the app
 * writes, and never the ones contacted. The HTTP layer sends each request to a
 * healthy regional node of the same service instead: the Rust proxy on
 * desktop (`apps/desktop/src-tauri/src/endpoints.rs`), `lib/http/regions.ts`
 * on the web. Letting DNS pick the region per lookup is what once caused the
 * "phantom drift" between two regions' report sets.
 */
import { getConfig } from "@/lib/config";

export const HOST = {
  lbApi: "api.lb.exptech.dev",
  lbStatic: "static.lb.exptech.dev",
  coreApi: "api.core.exptech.dev",
  coreStatic: "static.core.exptech.dev",
} as const;

/**
 * The realtime API's host: the proxy domain set under 設定 → API 代理網域, or
 * the balanced LB name by default. The default is routed like any balanced
 * name; a proxy of the user's own is used as given.
 */
export function lbApiHost(): string {
  return normalizeHost(getConfig().apiProxyDomain) || HOST.lbApi;
}

function normalizeHost(value: string | undefined): string {
  const raw = value?.trim();
  if (!raw) return "";
  try {
    return new URL(raw.includes("://") ? raw : `https://${raw}`).host;
  } catch {
    return raw.replace(/^https?:\/\//, "").split("/")[0];
  }
}
