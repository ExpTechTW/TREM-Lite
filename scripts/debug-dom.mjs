import { webkit } from "playwright";

const browser = await webkit.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 815 }, deviceScaleFactor: 1 });
page.on("pageerror", (e) => console.log("[PAGEERROR]", e.message));
await page.goto("http://localhost:1420/", { waitUntil: "domcontentloaded", timeout: 30000 });
await page.waitForTimeout(12000);

const info = await page.evaluate(() => {
  const t = window.__trem;
  const map = t?.variable.map;
  const q = (id, layer) => {
    try {
      return map.querySourceFeatures(id).length;
    } catch (e) {
      return "err:" + e.message;
    }
  };
  const reports = t?.variable.data.report || [];
  // Find the report scroll container: the div with many children on the right.
  const all = [...document.querySelectorAll("div")];
  const rightPanels = all
    .filter((d) => {
      const r = d.getBoundingClientRect();
      return r.left > 900 && r.width > 200 && r.height > 300;
    })
    .map((d) => ({
      cls: d.className.slice(0, 60),
      children: d.children.length,
      rect: `${Math.round(d.getBoundingClientRect().left)},${Math.round(d.getBoundingClientRect().top)} ${Math.round(d.getBoundingClientRect().width)}x${Math.round(d.getBoundingClientRect().height)}`,
      html: d.innerHTML.slice(0, 200),
    }));
  return {
    reportsLen: reports.length,
    firstReport: reports[0] ? JSON.stringify(reports[0]).slice(0, 260) : null,
    rtsFeatures: q("rts"),
    markersFeatures: q("markers-geojson"),
    reportMarkers: q("report-markers-geojson"),
    layers: map ? map.getStyle().layers.map((l) => l.id) : [],
    rightPanels,
  };
});
console.log(JSON.stringify(info, null, 2));
await browser.close();
