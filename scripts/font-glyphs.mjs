// Collects every character the UI can render, so Maple Mono NF CN can be subset
// to a tiny woff2. Sources: printable ASCII + all region.json place names + all
// non-ASCII chars in the frontend source + a curated CWA report/seismic vocab
// (covers dynamic report/EEW location strings from the API). Writes glyphs.txt.
import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { resolve, join } from "node:path";

const CORE = resolve(import.meta.dir, "../packages/core/src");
const chars = new Set();

// 1) printable ASCII
for (let c = 0x20; c <= 0x7e; c++) chars.add(String.fromCharCode(c));

// 2) all place-name characters from region.json (city + town keys)
const region = JSON.parse(readFileSync(join(CORE, "data/region.json"), "utf8"));
for (const city of Object.keys(region)) {
  for (const ch of city) chars.add(ch);
  for (const town of Object.keys(region[city])) for (const ch of town) chars.add(ch);
}

// 3) every non-ASCII char that appears literally in the frontend source
function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p);
    else if (/\.(ts|tsx|css|html)$/.test(name)) {
      for (const ch of readFileSync(p, "utf8")) if (ch.codePointAt(0) > 0x7e) chars.add(ch);
    }
  }
}
walk(CORE);
// html entries live at packages/core root
for (const f of ["index.html", "pip.html", "settings.html"]) {
  try {
    for (const ch of readFileSync(resolve(CORE, "..", f), "utf8")) if (ch.codePointAt(0) > 0x7e) chars.add(ch);
  } catch {}
}

// 4) curated CWA report / EEW / seismic vocabulary for dynamic API strings
//    (report loc: "<縣市>政府<方位> <n> 公里 (位於<地區>)"; EEW/intensity terms)
const vocab =
  "臺台灣澎金馬祖縣市鄉鎮區村里島嶼山溪河湖潭港灣海洋峽" +
  "東西南北中方位近海外海域部政府附交界之及與地表" +
  "公里公尺公分毫秒級弱強規模深度震度最大觀測加速度速度" +
  "地震海嘯預警警報速報資訊目前無暫生效中發布時間規模" +
  "全國各地區搖晃強度預估抵達秒後請注意安全避難掩護" +
  "年月日時分秒週一二三四五六日上下午早晚點左右約" +
  "。，、；：！？（）「」『』〜～—…·　";
for (const ch of vocab) chars.add(ch);

// Emit sorted for stable diffs.
const text = [...chars].sort((a, b) => a.codePointAt(0) - b.codePointAt(0)).join("");
const out = resolve(import.meta.dir, "../packages/core/src/assets/fonts/.glyphs.txt");
writeFileSync(out, text);
console.log(`collected ${chars.size} unique glyphs → ${out}`);
console.log(`(ascii + region names + source + curated vocab)`);
