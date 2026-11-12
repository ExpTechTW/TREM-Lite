/**
 * base64 for the plugin host.
 *
 * Rust hands a plugin's files over as base64 (assets are not text), and the
 * browser's own `atob`/`btoa` are the fastest route that needs no dependency —
 * but they cannot carry more than 64 KiB in one call in older engines, so the
 * decoding is done in chunks.
 */

const CHUNK = 0x8000;

/**
 * A view backed by a plain `ArrayBuffer`.
 *
 * Named because WebCrypto's `BufferSource` refuses a `Uint8Array` that might be
 * backed by a `SharedArrayBuffer`, and the default type argument is exactly
 * that union.
 */
export type Bytes = Uint8Array<ArrayBuffer>;

export function decodeBase64(data: string): Bytes {
  if (data.length <= CHUNK) {
    const binary = atob(data);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
  }
  // A long payload decodes a chunk at a time: a 1 MB plugin would otherwise
  // pass an 800 kB string to `atob`, which some engines reject outright.
  const parts: Bytes[] = [];
  let total = 0;
  for (let offset = 0; offset < data.length; offset += CHUNK) {
    const binary = atob(data.slice(offset, offset + CHUNK));
    const part = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) part[i] = binary.charCodeAt(i);
    parts.push(part);
    total += part.length;
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

export function encodeBase64(bytes: Uint8Array<ArrayBufferLike>): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + CHUNK));
  }
  return btoa(binary);
}
