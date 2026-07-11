import { webkit } from "playwright";
const browser = await webkit.launch();
// old.png is 1038x635 (=1280-native @0.81). Render mine downscaled to the same 0.81.
const NW = Math.round(1280*0.811), NH = Math.round(815*0.811); // ~1038 x 661
const page = await browser.newPage({ viewport: { width: 1038, height: NH*2+40 }, deviceScaleFactor: 2 });
const html = `<!doctype html><html><head><style>
 *{margin:0;padding:0} body{background:#000}
 .lbl{color:#8f8;font:bold 12px monospace;padding:2px 6px;background:#111}
 .legacy{width:1038px;height:635px;display:block}
 .new{width:${NW}px;height:${NH}px;display:block}
</style></head><body>
 <div class="lbl">LEGACY (native)</div>
 <img class="legacy" src="http://localhost:1420/old.png">
 <div class="lbl">NEW (downscaled to legacy scale)</div>
 <img class="new" src="http://localhost:1420/prev.png">
</body></html>`;
await page.setContent(html, { waitUntil: "networkidle" });
await page.waitForTimeout(1200);
await page.screenshot({ path: "/tmp/cmp3.png", fullPage: true });
await browser.close();
console.log("cmp3 -> /tmp/cmp3.png");
