/**
 * Fixtures for the stream tests: frames as the SSE server writes them. Every
 * value here is made up; nothing is fetched.
 */
import { gzipSync, strToU8 } from "fflate";

/** base64(gzip(text)), as the server writes every topic's data field. */
export function packed(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return Buffer.from(gzipSync(strToU8(text))).toString("base64");
}

/** One SSE block. */
export function block(event: string | null, data: string): string {
  return `${event ? `event: ${event}\n` : ""}data: ${data}\n\n`;
}

export const GREETING = {
  location: "lb-test",
  topics: ["eq.eew.v1", "trem.intensity.v1", "eq.report.v1", "trem.rts.v1"],
  anonymous: true,
};

/** A station frame: one alerting station, one quiet. */
export const RTS = {
  source: "core-test",
  ts: 1790000000000,
  stations: { "117825C": { i: 2.1, pga: 3.5, alert: 1 }, "11336952": { i: -0.3, pga: 0.4 } },
  eq: [],
};

/** An EEW snapshot: the whole list in force. */
export const EEW_SNAPSHOT = [
  {
    author: "cwa",
    id: "1150001",
    serial: 2,
    status: 0,
    final: 0,
    eq: { time: 1790000000000, lon: 121.5, lat: 23.9, depth: 10, mag: 5.1, loc: "花蓮縣近海", max: 4 },
    time: 1790000012000,
  },
];

export const INTENSITY_XML =
  "<Report><Head><EventID>20260917120000</EventID><InfoType>發表</InfoType><Serial>1</Serial></Head>" +
  '<Body><Area level="2"><Town code="970"/></Area><Area level="1"><Town code="972"/><Town code="973"/></Area></Body></Report>';

/** One report's `data`, as eq.report.v1 carries it. */
export function reportData(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: "115079-2026-1109-122157",
    lat: 23.62,
    lon: 120.66,
    depth: 10.5,
    loc: "雲林縣政府東南東方  23.2  公里 (位於雲林縣古坑鄉)",
    mag: 4.2,
    time: 1794198117000,
    list: {
      雲林縣: { int: 3, town: { 草嶺: { lat: 23.6, lon: 120.68, int: 3 } } },
      嘉義縣: { int: 2, town: { 阿里山: { lat: 23.5, lon: 120.8, int: 2 } } },
    },
    ...over,
  };
}
