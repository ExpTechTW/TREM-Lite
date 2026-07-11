// Loads the REAL app (index.html) in headless WebKit (same engine as Tauri's
// WKWebView) against LIVE data via native fetch (endpoints send CORS *), then
// captures the console timeline + a screenshot so we can see why dots/reports
// don't render. Usage: node scripts/debug-live.mjs [seconds] [outfile]
import { webkit } from "playwright";

const secs = Number(process.argv[2] || 16);
const out = process.argv[3] || "/tmp/trem-live.png";
const url = "http://localhost:1420/";

const browser = await webkit.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 815 }, deviceScaleFactor: 1 });

const t0 = Date.now();
const stamp = () => `+${((Date.now() - t0) / 1000).toFixed(1)}s`;
page.on("console", (m) => console.log(`${stamp()} [${m.type()}]`, m.text()));
page.on("pageerror", (e) => console.log(`${stamp()} [PAGEERROR]`, e.message));
page.on("requestfailed", (r) =>
  console.log(`${stamp()} [REQFAIL]`, r.url().slice(0, 80), r.failure()?.errorText),
);

await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 }).catch((e) => console.log("goto:", e.message));

await page.waitForTimeout(secs * 1000);

// Probe live state from inside the page (exposed via window.__trem in main.tsx).
const state = await page
  .evaluate(() => {
    const t = window.__trem;
    if (!t) return { exposed: false };
    const map = t.variable.map;
    const srcCount = (id) => {
      try {
        return map?.getSource(id)?._data?.features?.length ?? "n/a";
      } catch {
        return "err";
      }
    };
    return {
      exposed: true,
      stations: Object.keys(t.variable.station || {}).length,
      reports: (t.variable.data.report || []).length,
      rtsFeatures: srcCount("rts"),
      reportFeatures: srcCount("report-markers-geojson"),
      styleLoaded: map?.isStyleLoaded?.() ?? "no map",
      hasMap: !!map,
    };
  })
  .catch((e) => ({ evalError: e.message }));

console.log(`${stamp()} STATE`, JSON.stringify(state));

await page.screenshot({ path: out });
await browser.close();
console.log("screenshot ->", out);
