import { webkit } from "playwright";
const browser = await webkit.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 815 } });
const log = [];
await page.exposeFunction("__setd", (id, n) => log.push(`${id}=${n}`));
await page.goto("http://localhost:1420/", { waitUntil: "domcontentloaded", timeout: 30000 });
await page.waitForTimeout(2500);
await page.evaluate(() => {
  const map = window.__trem.variable.map;
  for (const id of ["rts", "markers-geojson", "markers-geojson-0"]) {
    const s = map.getSource(id);
    if (!s) continue;
    const orig = s.setData.bind(s);
    s.setData = (d) => {
      window.__setd(id, d?.features?.length ?? 0);
      return orig(d);
    };
  }
});
await page.waitForTimeout(8000);
const rendered = await page.evaluate(() => {
  const map = window.__trem.variable.map;
  const r = (layer) => {
    try {
      return map.queryRenderedFeatures({ layers: [layer] }).length;
    } catch (e) {
      return "err:" + e.message;
    }
  };
  return { rtsLayer: r("rts-layer"), markers0: r("markers-0"), markers: r("markers") };
});
console.log("setData calls (last 8):", log.slice(-8).join("  "));
console.log("rendered features:", JSON.stringify(rendered));
await browser.close();
