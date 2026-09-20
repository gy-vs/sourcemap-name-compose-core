import type { ComposedMap } from './compose.js';
import type { ComposedSegment, DecodedSegment, EncodedSourceMap } from './types.js';
import { NameTable } from './names.js';
import { decodeVlq, encodeVlq } from './vlq.js';

export type EncodeOptions = {
  /**
   * Sort the names table before encoding. Indices are remapped so every
   * segment still points at the same name string — reordering the table
   * never changes segment meaning.
   */
  sortNames?: boolean;
};

export function encodeMap(map: ComposedMap, options: EncodeOptions = {}): EncodedSourceMap {
  const segments = map.segments();
  const sources: string[] = [];
  const sourceIndex = new Map<string, number>();
  const table = new NameTable();
  for (const segment of segments) {
    if (segment.source === undefined) continue;
    if (!sourceIndex.has(segment.source)) {
      sourceIndex.set(segment.source, sources.length);
      sources.push(segment.source);
    }
    if (segment.name !== undefined) table.intern(segment.name);
  }
  let names = [...table.names];
  let remap: number[] | null = null;
  if (options.sortNames) {
    const sorted = table.sorted();
    names = sorted.names;
    remap = sorted.remap;
  }
  const nameIndexOf = (name: string): number => {
    const index = table.intern(name);
    return remap === null ? index : remap[index];
  };

  const lines: (ComposedSegment[] | undefined)[] = [];
  for (const segment of segments) {
    (lines[segment.generatedLine - 1] ??= []).push(segment);
  }
  let prevSource = 0;
  let prevOriginalLine = 0;
  let prevOriginalColumn = 0;
  let prevName = 0;
  const encodedLines: string[] = [];
  for (let line = 0; line < lines.length; line++) {
    let prevGeneratedColumn = 0; // generated column deltas reset on every line
    encodedLines.push(
      (lines[line] ?? [])
        .map((segment) => {
          let out = encodeVlq(segment.generatedColumn - prevGeneratedColumn);
          prevGeneratedColumn = segment.generatedColumn;
          if (segment.source === undefined) return out; // unmapped segment: one field only
          const source = sourceIndex.get(segment.source)!;
          out += encodeVlq(source - prevSource);
          prevSource = source;
          const originalLine = segment.originalLine! - 1; // VLQ stores 0-based original lines
          out += encodeVlq(originalLine - prevOriginalLine);
          prevOriginalLine = originalLine;
          out += encodeVlq(segment.originalColumn! - prevOriginalColumn);
          prevOriginalColumn = segment.originalColumn!;
          if (segment.name !== undefined) {
            const name = nameIndexOf(segment.name);
            out += encodeVlq(name - prevName);
            prevName = name;
          }
          return out;
        })
        .join(','),
    );
  }
  return { version: 3, sources, names, mappings: encodedLines.join(';') };
}

/** Decodes an encoded map, resolving every segment's source and name through the tables. */
export function decodeMap(encoded: EncodedSourceMap): DecodedSegment[] {
  const { sources, names, mappings } = encoded;
  const segments: DecodedSegment[] = [];
  let prevSource = 0;
  let prevOriginalLine = 0;
  let prevOriginalColumn = 0;
  let prevName = 0;
  const lines = mappings.split(';');
  for (let line = 0; line < lines.length; line++) {
    if (lines[line] === '') continue;
    let prevGeneratedColumn = 0;
    for (const part of lines[line].split(',')) {
      let offset = 0;
      const read = (): number => {
        const decoded = decodeVlq(part, offset);
        offset = decoded.next;
        return decoded.value;
      };
      const generatedColumn = prevGeneratedColumn + read();
      prevGeneratedColumn = generatedColumn;
      const segment: DecodedSegment = { generatedLine: line + 1, generatedColumn };
      if (offset < part.length) {
        const sourceIndex = prevSource + read();
        prevSource = sourceIndex;
        const source = sources[sourceIndex];
        if (source === undefined) throw new Error(`source index ${sourceIndex} out of range`);
        segment.source = source;
        const originalLine = prevOriginalLine + read();
        prevOriginalLine = originalLine;
        segment.originalLine = originalLine + 1;
        const originalColumn = prevOriginalColumn + read();
        prevOriginalColumn = originalColumn;
        segment.originalColumn = originalColumn;
        if (offset < part.length) {
          const nameIndex = prevName + read();
          prevName = nameIndex;
          const name = names[nameIndex];
          if (name === undefined) throw new Error(`name index ${nameIndex} out of range`);
          segment.name = name;
        }
        if (offset < part.length) throw new Error('segment has more than five fields');
      }
      segments.push(segment);
    }
  }
  return segments;
}
