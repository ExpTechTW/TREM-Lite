/**
 * 網頁版的日誌檔：localStorage，版面照桌面版的 logs/YYYY/MM/DD/HH.log(.gz)。
 *
 *   trem.log/2026/09/29/03.log.0   正在寫的小時；每段最多 CHUNK 字，寫滿換下一段
 *   trem.log/2026/09/29/02.log.gz  過去的小時，gzip 後以 base64 存放
 *
 * 分段是為了寫入便宜：localStorage 每次都整個值重寫，把一整小時放在同一個值裡，
 * 每寫一行就要重寫幾百 KB。
 *
 * 整理跟桌面版一樣：過去的小時壓成 gzip，7 天前的刪掉；載入後做一次，之後每小時、
 * 以及寫入跨過整點時。另外 localStorage 整個網域只有約 5 MB，還要放設定、測站與
 * 報告的快取，所以日誌總量另有上限 LIMIT，超過就從最舊的小時刪起——兩條規則先到
 * 的那條生效。
 */
import { inTauri } from "./env";

const PREFIX = "trem.log/";
/** 一段最多幾個字元。 */
const CHUNK = 32 * 1024;
/** 所有日誌加起來最多幾個字元（localStorage 以字元計）。 */
const LIMIT = 1_000_000;
const KEEP_DAYS = 7;
const TIDY_MS = 3_600_000;

/** 一個小時的日誌：未壓縮的各段，與壓好的那份。 */
interface Hour {
  parts: { n: number; key: string }[];
  gz: string | null;
}

const KEY_RE = /^trem\.log\/(\d{4}\/\d{2}\/\d{2}\/\d{2})\.log\.(gz|\d+)$/;

const pad = (n: number) => String(n).padStart(2, "0");

/** `YYYY/MM/DD/HH`，本地時間。 */
export function hourOf(t: number): string {
  const d = new Date(t);
  return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())}/${pad(d.getHours())}`;
}

const partKey = (hour: string, n: number) => `${PREFIX}${hour}.log.${n}`;
const gzKey = (hour: string) => `${PREFIX}${hour}.log.gz`;

function storage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null; // 被封鎖的儲存空間，存取就會丟例外
  }
}

/** 所有日誌依小時分好，由舊到新。 */
function hours(ls: Storage): Map<string, Hour> {
  const found = new Map<string, Hour>();
  for (let i = 0; i < ls.length; i++) {
    const key = ls.key(i);
    const m = key ? KEY_RE.exec(key) : null;
    if (!key || !m) continue;
    const hour = found.get(m[1]) ?? { parts: [], gz: null };
    if (m[2] === "gz") hour.gz = key;
    else hour.parts.push({ n: Number(m[2]), key });
    found.set(m[1], hour);
  }
  for (const hour of found.values()) hour.parts.sort((a, b) => a.n - b.n);
  return new Map([...found].sort(([a], [b]) => (a < b ? -1 : 1)));
}

function removeHour(ls: Storage, hour: Hour): void {
  for (const p of hour.parts) ls.removeItem(p.key);
  if (hour.gz) ls.removeItem(hour.gz);
}

/** 刪掉最舊的一個小時（`keep` 那個小時除外）；沒有可刪的就回傳 false。 */
function evictOldest(ls: Storage, keep: string): boolean {
  for (const [name, hour] of hours(ls)) {
    if (name === keep) continue;
    removeHour(ls, hour);
    return true;
  }
  return false;
}

/** 寫入；空間不夠就從最舊的日誌刪起再試，永遠不動日誌以外的鍵。 */
function write(ls: Storage, key: string, value: string, keep: string): boolean {
  for (;;) {
    try {
      ls.setItem(key, value);
      return true;
    } catch {
      if (!evictOldest(ls, keep)) return false;
    }
  }
}

let buffer = "";
/** 正在寫的小時與段號。 */
let current = "";
let part = 0;

/** 記下一行（已格式化、含換行）。同一個工作階段的行合成一次寫入。 */
export function appendLine(line: string): void {
  if (!buffer) queueMicrotask(flush);
  buffer += line;
}

function flush(): void {
  const text = buffer;
  buffer = "";
  const ls = storage();
  if (!ls || !text) return;

  const hour = hourOf(Date.now());
  if (hour !== current) {
    const crossed = current !== "";
    current = hour;
    part = hours(ls).get(hour)?.parts.at(-1)?.n ?? 0;
    if (crossed) void tidy();
  }
  // 另一個分頁可能已經寫到下一段了。
  while (ls.getItem(partKey(current, part + 1)) !== null) part++;

  const existing = ls.getItem(partKey(current, part)) ?? "";
  if (existing && existing.length + text.length > CHUNK) {
    part++;
    write(ls, partKey(current, part), text, current);
  } else {
    write(ls, partKey(current, part), existing + text, current);
  }
}

function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

function fromBase64(b64: string): Uint8Array<ArrayBuffer> {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

/** gzip 後的 base64；瀏覽器沒有 CompressionStream 就回傳 null，留著原文。 */
async function gzip(text: string): Promise<string | null> {
  if (typeof CompressionStream === "undefined") return null;
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"));
  return toBase64(new Uint8Array(await new Response(stream).arrayBuffer()));
}

async function gunzip(b64: string): Promise<string> {
  const stream = new Blob([fromBase64(b64)]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Response(stream).text();
}

/** 本地日期（`YYYY/MM/DD`）往前推幾天。 */
function dayBefore(t: number, days: number): string {
  const d = new Date(t);
  d.setDate(d.getDate() - days);
  return hourOf(d.getTime()).slice(0, 10);
}

let tidying = false;

/**
 * 壓縮已過的小時、刪掉 7 天前的、把總量壓在 LIMIT 以下。回傳做了什麼，供記錄。
 * 正在寫的那個小時不動：它隨時會續寫。
 */
export async function tidy(now = Date.now()): Promise<{ zipped: number; removed: number }> {
  const done = { zipped: 0, removed: 0 };
  const ls = storage();
  if (!ls || tidying) return done;
  tidying = true;
  try {
    const hourNow = hourOf(now);
    for (const [name, hour] of hours(ls)) {
      if (name === hourNow || !hour.parts.length) continue;
      // 壓好之後，另一個分頁又補寫了幾行：接在原本那份後面重壓。
      const before = hour.gz ? await gunzip(ls.getItem(hour.gz) ?? "").catch(() => "") : "";
      const text = before + hour.parts.map((p) => ls.getItem(p.key) ?? "").join("");
      const packed = await gzip(text);
      if (packed === null) break;
      if (write(ls, gzKey(name), packed, hourNow)) {
        for (const p of hour.parts) ls.removeItem(p.key);
        done.zipped++;
      }
    }

    const cutoff = dayBefore(now, KEEP_DAYS);
    for (const [name, hour] of hours(ls)) {
      if (name.slice(0, 10) >= cutoff) break;
      removeHour(ls, hour);
      done.removed++;
    }

    const size = () => {
      let total = 0;
      for (const hour of hours(ls).values()) {
        for (const p of hour.parts) total += ls.getItem(p.key)?.length ?? 0;
        if (hour.gz) total += ls.getItem(hour.gz)?.length ?? 0;
      }
      return total;
    };
    while (size() > LIMIT && evictOldest(ls, hourNow)) done.removed++;
  } finally {
    tidying = false;
  }
  return done;
}

/** 所有日誌由舊到新串成一份文字，給「下載日誌」。 */
export async function exportLogs(): Promise<string> {
  flush();
  const ls = storage();
  if (!ls) return "";
  const out: string[] = [];
  for (const hour of hours(ls).values()) {
    if (hour.gz) out.push(await gunzip(ls.getItem(hour.gz) ?? "").catch(() => ""));
    for (const p of hour.parts) out.push(ls.getItem(p.key) ?? "");
  }
  return out.join("");
}

/** 網頁版才用得到；桌面版的日誌在 Rust 那邊整理。 */
export function startLogStore(onTidy: (done: { zipped: number; removed: number }) => void): void {
  if (inTauri || typeof window === "undefined") return;
  const run = () =>
    void tidy().then((done) => {
      if (done.zipped || done.removed) onTidy(done);
    });
  window.setTimeout(run, 5_000);
  window.setInterval(run, TIDY_MS);
  // 關閉或切走分頁前把還沒寫進去的行寫掉。
  window.addEventListener("pagehide", flush);
}
