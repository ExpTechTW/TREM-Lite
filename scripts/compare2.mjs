import { webkit } from "playwright";
const W = 1038, H = 635;
const browser = await webkit.launch();
const page = await browser.newPage({ viewport: { width: W, height: H * 2 + 30 }, deviceScaleFactor: 2 });
const html = `<!doctype html><html><head><style>
  *{margin:0;padding:0} body{background:#000}
  .lbl{color:#8f8;font:bold 12px monospace;padding:2px 6px;background:#111;height:15px}
  img,iframe{width:${W}px;height:${H}px;display:block;border:0}
</style></head><body>
  <div class="lbl">LEGACY old.png (native ${W}x${H})</div>
  <img src="http://localhost:1420/old.png">
  <div class="lbl">NEW preview (${W}x${H})</div>
  <iframe src="http://localhost:1420/preview.html"></iframe>
</body></html>`;
await page.setContent(html, { waitUntil: "networkidle" });
await page.waitForTimeout(2500);
await page.screenshot({ path: "/tmp/trem-compare2.png", fullPage: true });
await browser.close();
console.log("compare2 -> /tmp/trem-compare2.png");
