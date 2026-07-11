import { webkit } from "playwright";
const browser = await webkit.launch();
const NW = Math.round(1280*0.811), NH = Math.round(815*0.811);
const page = await browser.newPage({ viewport: { width: 1038, height: 635+NH+40 }, deviceScaleFactor: 2 });
const html = `<!doctype html><html><head><style>
 *{margin:0;padding:0} body{background:#000}
 .lbl{color:#8f8;font:bold 12px monospace;padding:2px 6px;background:#111}
 .legacy{width:1038px;height:635px;display:block}
 .new{width:${NW}px;height:${NH}px;display:block}
</style></head><body>
 <div class="lbl">LEGACY old.png</div><img class="legacy" src="http://localhost:1420/old.png">
 <div class="lbl">REAL app (live data, current code) downscaled to legacy scale</div>
 <img class="new" src="http://localhost:1420/real.png">
</body></html>`;
await page.setContent(html, { waitUntil: "networkidle" });
await page.waitForTimeout(1000);
await page.screenshot({ path: "/tmp/cmp-real.png", fullPage: true });
await browser.close();
console.log("done");
