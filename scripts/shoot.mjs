// Headless WebKit screenshot of a page (matches Tauri's WKWebView engine).
// Usage: node scripts/shoot.mjs [url] [outfile]
import { webkit } from "playwright";

const url = process.argv[2] || "http://localhost:1420/preview.html";
const out = process.argv[3] || "/tmp/trem-preview.png";

const browser = await webkit.launch();
const page = await browser.newPage({
  viewport: { width: 1280, height: 815 },
  deviceScaleFactor: 2,
});
page.on("console", (m) => {
  if (m.type() === "error") console.log("[page error]", m.text());
});
page.on("pageerror", (e) => console.log("[pageerror]", e.message));

await page.goto(url, { waitUntil: "networkidle", timeout: 30000 }).catch((e) => {
  console.log("goto warning:", e.message);
});
await page.waitForTimeout(1800);
await page.screenshot({ path: out });
await browser.close();
console.log("screenshot ->", out);
