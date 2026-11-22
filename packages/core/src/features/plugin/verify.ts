/**
 * Signature checking, ported from `legacy/src/js/core/verify.js`.
 *
 * The Electron build verified with `crypto.createVerify('SHA256')`; WebCrypto's
 * RSASSA-PKCS1-v1_5 with SHA-256 is the same scheme, so a `signature.json`
 * written for TREM-Lite 3 verifies here unchanged. Two details decide whether
 * that is actually true:
 *
 *   - the hash covers the LF form of each file's text, not its bytes, so the
 *     same plugin verifies after being unzipped on Windows with CRLF endings;
 *   - the signed message is the UTF-8 bytes of `JSON.stringify(fileHashes)`,
 *     in the key order the signer wrote, so the check must not re-serialise.
 */
import { decodeBase64, type Bytes } from "./base64";
import type { PluginSignature, VerifyResult } from "./types";

/**
 * ExpTech's release key (`legacy/src/js/core/plugin.js:33`). `keyId` absent or
 * `official` selects this one; any other id must have a `.pem` of that name in
 * `<app_config_dir>/plugin-keys`.
 */
export const OFFICIAL_KEY = `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAzQn1ouv0mfzVKJevJiq+
6rV9mwCEvQpauQ2QNjy4TiwhqzqNiOPwpM3qo+8+3Ld+DUhzZzSzyx894dmJGlWQ
wNss9Vs5/gnuvn6PurNXC42wkxY6Dmsnp/M6g08iqGXVcM6ZWmvCZ3BzBvwExxRR
09KxHZVhwoMcF5Kp9l/hNZqXRgYMn3GLt+m78Hr+ZUjHiF8K9UH2TPxKRa/4ttPX
6nDBZxZUCwFD7Zh6RePg07JDbO5fI/UYrqZYyDPK8w9xdXtke9LbdXmMuuk/x57h
foRArUkhPvUk/77mxo4++3EFnTUxYMnQVuMkDaYNRu7w83abUuhsjNlL/es24HSm
lwIDAQAB
-----END PUBLIC KEY-----`;

/** `\r\n` and a lone `\r` both become `\n` — what the signer hashed. */
export function normalizeContent(content: string): string {
  return content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

const decoder = new TextDecoder("utf-8");
const encoder = new TextEncoder();

/** Rust hands files over base64, so a plugin may ship binary assets. */
export function decodeFile(data: string): Bytes {
  return decodeBase64(data);
}

/** The text the hashes cover: Node's `readFileSync(path, 'utf8')` equivalent. */
export function fileText(bytes: Uint8Array): string {
  return normalizeContent(decoder.decode(bytes));
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** A `-----BEGIN PUBLIC KEY-----` block as the DER bytes WebCrypto imports. */
export function pemToBytes(pem: string): Bytes {
  const body = pem.replace(/-----(BEGIN|END) PUBLIC KEY-----/g, "").replace(/\s+/g, "");
  return decodeBase64(body);
}

/**
 * Verify one plugin directory.
 *
 * `files` is keyed by the path relative to the plugin root, POSIX style.
 * Hidden entries and `signature.json` itself are not part of the signed set
 * (verify.js skipped both), and `trem.json` is hashed by neither side.
 */
export async function verifyPlugin(
  files: Map<string, Uint8Array>,
  keys: Map<string, string>,
): Promise<VerifyResult> {
  const raw = files.get("signature.json");
  if (!raw) return { valid: false, error: "Missing signature.json" };

  let parsed: PluginSignature;
  try {
    parsed = JSON.parse(decoder.decode(raw)) as PluginSignature;
  } catch (e) {
    return { valid: false, error: `signature.json 不是合法的 JSON：${String(e)}` };
  }

  const { fileHashes, signature, keyId } = parsed;
  if (!fileHashes || !signature) return { valid: false, error: "Invalid signature data format" };

  for (const [path, bytes] of files) {
    // A dot-file is the author's business; `trem.json` is written after
    // signing (it holds the install source), so neither is covered.
    if (path.startsWith(".") || path.split("/").some((part) => part.startsWith("."))) continue;
    if (path === "signature.json" || path === "trem.json") continue;

    if (!fileHashes[path]) return { valid: false, error: `Extra file: ${path}` };
    const actual = await sha256Hex(fileText(bytes));
    if (actual !== fileHashes[path]) return { valid: false, error: `Modified file: ${path}` };
  }

  const pem = !keyId || keyId === "official" ? OFFICIAL_KEY : keys.get(keyId);
  if (!pem) return { valid: false, error: `Unknown key ID: ${keyId}` };

  try {
    const key = await crypto.subtle.importKey(
      "spki",
      pemToBytes(pem),
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );
    const valid = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      key,
      decodeBase64(signature),
      encoder.encode(JSON.stringify(fileHashes)),
    );
    return { valid, error: valid ? undefined : "Invalid signature", keyId: keyId ?? "official" };
  } catch (e) {
    return { valid: false, error: `簽名驗證失敗：${String(e)}` };
  }
}
