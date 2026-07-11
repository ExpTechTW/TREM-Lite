import { webkit } from "playwright";
const b = await webkit.launch();
const p = await b.newPage();
await p.goto("http://localhost:1420/preview.html", { waitUntil: "domcontentloaded" }); // same-origin as images
async function badge(url, label) {
  const m = await p.evaluate(async (u) => {
    const img = new Image(); img.src = u; await img.decode();
    const cv = document.createElement("canvas"); cv.width = img.naturalWidth; cv.height = img.naturalHeight;
    const cx = cv.getContext("2d"); cx.drawImage(img, 0, 0);
    const W = cv.width, H = cv.height;
    const d = cx.getImageData(0, 0, W, H).data;
    let minX=W,maxX=0,minY=H,maxY=0,count=0;
    for (let y=0; y<Math.floor(H*0.28); y++) for (let x=Math.floor(W*0.72); x<W; x++){
      const i=(y*W+x)*4, r=d[i],g=d[i+1],bl=d[i+2];
      if (bl>150 && r<90 && g>80 && g<190){ count++; if(x<minX)minX=x; if(x>maxX)maxX=x; if(y<minY)minY=y; if(y>maxY)maxY=y; }
    }
    return { W, H, count, bw: maxX-minX, bh: maxY-minY };
  }, url);
  const pct = (m.bw/m.W*100).toFixed(2);
  return `${label}: img ${m.W}x${m.H} | badge ${m.bw}x${m.bh}px | ${pct}% of width | count ${m.count}`;
}
console.log(await badge("http://localhost:1420/old.png", "LEGACY"));
console.log(await badge("http://localhost:1420/prev.png", "NEW   "));
await b.close();
