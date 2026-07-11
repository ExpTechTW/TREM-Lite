import { webkit } from "playwright";
const browser = await webkit.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 815 } });
await page.goto("http://localhost:1420/", { waitUntil: "domcontentloaded", timeout: 30000 });
await page.waitForTimeout(6000);
// Sample the rts GeoJSON source feature count every 700ms for ~10s.
for (let i = 0; i < 14; i++) {
  const c = await page.evaluate(() => {
    const map = window.__trem?.variable.map;
    const cnt = (id) => {
      try {
        const s = map.getSource(id);
        return s?._data?.features?.length ?? map.querySourceFeatures(id).length;
      } catch {
        return -1;
      }
    };
    return { rts: cnt("rts"), mk: cnt("markers-geojson"), mk0: cnt("markers-geojson-0") };
  });
  console.log(`t+${(6 + i * 0.7).toFixed(1)}s  rts=${c.rts} markers=${c.mk} markers0=${c.mk0}`);
  await page.waitForTimeout(700);
}
await browser.close();
