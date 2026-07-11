// Stacks legacy old.png (scaled to 1280) directly above the live preview at 1280,
// so the same x-positions line up column-for-column. Screenshot for visual diff.
import { webkit } from "playwright";

const browser = await webkit.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 1650 }, deviceScaleFactor: 1 });
const html = `<!doctype html><html><head><style>
  *{margin:0;padding:0} body{background:#000}
  .lbl{color:#8f8;font:bold 13px monospace;padding:2px 6px;background:#111}
  img,iframe{width:1280px;display:block;border:0}
</style></head><body>
  <div class="lbl">LEGACY old.png (scaled to 1280w)</div>
  <img src="http://localhost:1420/old.png">
  <div class="lbl">NEW preview (1280x815)</div>
  <iframe src="http://localhost:1420/preview.html" style="height:815px"></iframe>
</body></html>`;
await page.setContent(html, { waitUntil: "networkidle" });
await page.waitForTimeout(2500);
await page.screenshot({ path: "/tmp/trem-compare.png", fullPage: true });
await browser.close();
console.log("compare -> /tmp/trem-compare.png");
