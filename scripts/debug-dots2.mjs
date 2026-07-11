import { webkit } from "playwright";
const browser = await webkit.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 815 } });
const rtsEvents = [];
await page.exposeFunction("__rtsSeen", (n) => rtsEvents.push(n));
await page.goto("http://localhost:1420/", { waitUntil: "domcontentloaded", timeout: 30000 });
await page.waitForTimeout(2000);
// Hook DataRts to count stations per event.
await page.evaluate(() => {
  window.__trem?.events.on("DataRts", (ans) => {
    const n = ans?.data?.station ? Object.keys(ans.data.station).length : 0;
    window.__rtsSeen(n);
  });
});
await page.waitForTimeout(9000);
const snap = await page.evaluate(() => {
  const t = window.__trem;
  const map = t.variable.map;
  const rtsData = t.variable.data.rts;
  const src = map.getSource("rts");
  let srcFeatures = -1;
  try {
    // maplibre GeoJSONSource keeps the last-set data on _data
    srcFeatures = src?._data?.features?.length ?? -1;
  } catch {}
  const stationKeys = Object.keys(t.variable.station || {});
  const rtsKeys = rtsData?.station ? Object.keys(rtsData.station) : [];
  const overlap = rtsKeys.filter((k) => stationKeys.includes(k)).length;
  return {
    stationMeta: stationKeys.length,
    rtsStations: rtsKeys.length,
    overlap,
    sampleRtsKey: rtsKeys[0],
    sampleInMeta: rtsKeys[0] ? stationKeys.includes(rtsKeys[0]) : null,
    srcFeatures,
    showIntensity: t.variable.cache.show_intensity,
    showLpgm: t.variable.cache.show_lpgm,
    eewLen: t.variable.data.eew.length,
  };
});
console.log("DataRts events station counts:", JSON.stringify(rtsEvents));
console.log("snapshot:", JSON.stringify(snap, null, 2));
await browser.close();
