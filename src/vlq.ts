const CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const SHIFT = 5;
const CONTINUATION = 1 << SHIFT;
const MASK = CONTINUATION - 1;

export function encodeVlq(value: number): string {
  let out = '';
  let vlq = value < 0 ? ((-value) << 1) | 1 : value << 1;
  do {
    let digit = vlq & MASK;
    vlq >>>= SHIFT;
    if (vlq > 0) digit |= CONTINUATION;
    out += CHARS[digit];
  } while (vlq > 0);
  return out;
}

export function decodeVlq(mappings: string, start: number): { value: number; next: number } {
  let result = 0;
  let shift = 0;
  let index = start;
  for (;;) {
    const digit = CHARS.indexOf(mappings[index]);
    if (digit < 0) throw new Error(`invalid base64 VLQ digit at offset ${index}`);
    index++;
    result |= (digit & MASK) << shift;
    if ((digit & CONTINUATION) === 0) break;
    shift += SHIFT;
  }
  const value = result >>> 1;
  return { value: (result & 1) === 1 ? -value : value, next: index };
}
