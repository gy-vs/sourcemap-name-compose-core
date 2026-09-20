import type { DecodedSegment } from './model.js';

const BASE64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const BASE64_VALUES: ReadonlyMap<string, number> = new Map(
  [...BASE64_CHARS].map((char, index) => [char, index]),
);

/** 解码一段 base64 VLQ 文本（一个 mappings 段内的全部字段）。 */
export function decodeVlqValues(text: string): number[] {
  const values: number[] = [];
  let current = 0;
  let shift = 0;
  for (const char of text) {
    const digit = BASE64_VALUES.get(char);
    if (digit === undefined) throw new Error(`Invalid VLQ digit: ${JSON.stringify(char)}`);
    current |= (digit & 31) << shift;
    if (digit & 32) {
      shift += 5;
      continue;
    }
    const value = current >>> 1;
    values.push((current & 1) === 1 ? -value : value);
    current = 0;
    shift = 0;
  }
  if (shift !== 0) throw new Error('Truncated VLQ sequence');
  return values;
}

/** 编码单个有符号整数为 base64 VLQ。 */
export function encodeVlqValue(value: number): string {
  let vlq = value < 0 ? ((-value) << 1) | 1 : value << 1;
  let encoded = '';
  do {
    let digit = vlq & 31;
    vlq >>>= 5;
    if (vlq > 0) digit |= 32;
    encoded += BASE64_CHARS[digit];
  } while (vlq > 0);
  return encoded;
}

/** 解码 source map v3 的 mappings 字符串为段列表（按生成位置升序）。 */
export function decodeMappings(mappings: string): DecodedSegment[] {
  const segments: DecodedSegment[] = [];
  let sourceIndex = 0;
  let originalLine = 0;
  let originalColumn = 0;
  let nameIndex = 0;
  const lines = mappings.split(';');
  for (let generatedLine = 0; generatedLine < lines.length; generatedLine++) {
    const line = lines[generatedLine];
    if (line === '') continue;
    let generatedColumn = 0;
    for (const part of line.split(',')) {
      if (part === '') continue;
      const fields = decodeVlqValues(part);
      generatedColumn += fields[0];
      if (fields.length === 1) {
        segments.push({
          generatedLine,
          generatedColumn,
          sourceIndex: -1,
          originalLine: -1,
          originalColumn: -1,
          nameIndex: -1,
        });
        continue;
      }
      if (fields.length !== 4 && fields.length !== 5) {
        throw new Error(`Invalid segment field count: ${fields.length}`);
      }
      sourceIndex += fields[1];
      originalLine += fields[2];
      originalColumn += fields[3];
      let segmentNameIndex = -1;
      if (fields.length === 5) {
        nameIndex += fields[4];
        segmentNameIndex = nameIndex;
      }
      segments.push({
        generatedLine,
        generatedColumn,
        sourceIndex,
        originalLine,
        originalColumn,
        nameIndex: segmentNameIndex,
      });
    }
  }
  return segments;
}

/** 把段列表编码回 mappings 字符串。未映射段（sourceIndex < 0）只写生成列。 */
export function encodeMappings(segments: readonly DecodedSegment[]): string {
  const sorted = [...segments].sort(
    (a, b) => a.generatedLine - b.generatedLine || a.generatedColumn - b.generatedColumn,
  );
  let encoded = '';
  let currentLine = 0;
  let firstInLine = true;
  let previousGeneratedColumn = 0;
  let previousSource = 0;
  let previousOriginalLine = 0;
  let previousOriginalColumn = 0;
  let previousName = 0;
  for (const segment of sorted) {
    while (currentLine < segment.generatedLine) {
      encoded += ';';
      currentLine++;
      previousGeneratedColumn = 0;
      firstInLine = true;
    }
    if (!firstInLine) encoded += ',';
    firstInLine = false;
    encoded += encodeVlqValue(segment.generatedColumn - previousGeneratedColumn);
    previousGeneratedColumn = segment.generatedColumn;
    if (segment.sourceIndex < 0) continue;
    encoded += encodeVlqValue(segment.sourceIndex - previousSource);
    previousSource = segment.sourceIndex;
    encoded += encodeVlqValue(segment.originalLine - previousOriginalLine);
    previousOriginalLine = segment.originalLine;
    encoded += encodeVlqValue(segment.originalColumn - previousOriginalColumn);
    previousOriginalColumn = segment.originalColumn;
    if (segment.nameIndex >= 0) {
      encoded += encodeVlqValue(segment.nameIndex - previousName);
      previousName = segment.nameIndex;
    }
  }
  return encoded;
}
