import { webkit } from "playwright";
const W = 1280, H = 783; // legacy content area (1280x815 window minus ~28px titlebar)
const browser = await webkit.launch();
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 2 });
// old.png (scaled to 1280 wide) as the base; preview iframe on top at 45% opacity.
const html = `<!doctype html><html><head><style>
  *{margin:0;padding:0} html,body{width:${W}px;height:${H}px;overflow:hidden;background:#000}
  .wrap{position:relative;width:${W}px;height:${H}px}
  img{position:absolute;inset:0;width:${W}px;height:${H}px}
  iframe{position:absolute;inset:0;width:${W}px;height:${H}px;border:0;opacity:.5;mix-blend-mode:screen}
</style></head><body><div class="wrap">
  <img src="http://localhost:1420/old.png">
  <iframe src="http://localhost:1420/preview.html"></iframe>
</div></body></html>`;
await page.setContent(html, { waitUntil: "networkidle" });
await page.waitForTimeout(2500);
await page.screenshot({ path: "/tmp/trem-overlay.png" });
await browser.close();
console.log("overlay -> /tmp/trem-overlay.png");
