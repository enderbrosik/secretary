/** FNV-1a 64-bit — fast, deterministic, dependency-free content fingerprint for dedupe. */
export function fingerprint(...parts: Array<string | number | boolean | null | undefined>): string {
  let h = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const s = parts.map((p) => (p === null || p === undefined ? '' : String(p))).join('␟');
  for (let i = 0; i < s.length; i++) {
    h ^= BigInt(s.charCodeAt(i));
    h = (h * prime) & 0xffffffffffffffffn;
  }
  return h.toString(16).padStart(16, '0');
}

/** Normalises a subject line for cross-source dedupe ("Re: Fwd: Budget" -> "budget"). */
export function normalizeSubject(subject: string): string {
  return subject
    .replace(/^\s*((re|fw|fwd|aw|sv)\s*:\s*)+/i, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}
