import { webkit } from "playwright";
const b = await webkit.launch();
const p = await b.newPage({ deviceScaleFactor: 2 });
// Legacy featured card crop from old.png (native 1038x635)
await p.setViewportSize({ width: 1038, height: 635 });
await p.setContent(`<img src="http://localhost:1420/old.png" style="width:1038px;height:635px;display:block">`, { waitUntil: "networkidle" });
await p.waitForTimeout(600);
await p.screenshot({ path: "/tmp/card-legacy.png", clip: { x: 762, y: 4, width: 276, height: 118 } });
// New featured card crop from the live preview (1280x815); scale the clip by 0.811 to match
await p.setViewportSize({ width: 1280, height: 815 });
await p.goto("http://localhost:1420/preview.html", { waitUntil: "networkidle" });
await p.waitForTimeout(1500);
const box = await p.evaluate(() => {
  const c = [...document.querySelectorAll("div")].find(d => d.className.includes("rounded-[15px]") && d.textContent.includes("觀測最大震度"));
  const r = c.getBoundingClientRect();
  return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) };
});
console.log("new card box:", JSON.stringify(box));
await p.screenshot({ path: "/tmp/card-new.png", clip: box });
await b.close();
