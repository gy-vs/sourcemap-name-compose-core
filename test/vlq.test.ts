import { expect, it } from 'vitest';
import {
  decodeMappings,
  decodeVlqValues,
  encodeMappings,
  encodeSourceMap,
  encodeVlqValue,
  lookupSegment,
  parseSourceMap,
  type DecodedSegment,
} from '../src/index.js';

it('decodes and encodes single VLQ values', () => {
  expect(decodeVlqValues('A')).toEqual([0]);
  expect(decodeVlqValues('C')).toEqual([1]);
  expect(decodeVlqValues('D')).toEqual([-1]);
  expect(encodeVlqValue(0)).toBe('A');
  expect(encodeVlqValue(1)).toBe('C');
  expect(encodeVlqValue(-1)).toBe('D');
  for (const value of [0, 1, -1, 15, -15, 16, -16, 1023, -1023, 65536]) {
    expect(decodeVlqValues(encodeVlqValue(value))).toEqual([value]);
  }
});

it('decodes a fully mapped segment', () => {
  expect(decodeMappings('AAAA')).toEqual([
    { generatedLine: 0, generatedColumn: 0, sourceIndex: 0, originalLine: 0, originalColumn: 0, nameIndex: -1 },
  ]);
  expect(decodeMappings('AAAAA')).toEqual([
    { generatedLine: 0, generatedColumn: 0, sourceIndex: 0, originalLine: 0, originalColumn: 0, nameIndex: 0 },
  ]);
});

it('decodes unmapped segments and empty lines', () => {
  expect(decodeMappings('A')).toEqual([
    { generatedLine: 0, generatedColumn: 0, sourceIndex: -1, originalLine: -1, originalColumn: -1, nameIndex: -1 },
  ]);
  const segments = decodeMappings(';;AAAA');
  expect(segments).toHaveLength(1);
  expect(segments[0].generatedLine).toBe(2);
});

it('round-trips mappings through encode/decode', () => {
  const segments: DecodedSegment[] = [
    { generatedLine: 0, generatedColumn: 0, sourceIndex: 0, originalLine: 3, originalColumn: 2, nameIndex: 1 },
    { generatedLine: 0, generatedColumn: 9, sourceIndex: -1, originalLine: -1, originalColumn: -1, nameIndex: -1 },
    { generatedLine: 2, generatedColumn: 4, sourceIndex: 1, originalLine: 0, originalColumn: 7, nameIndex: 0 },
    { generatedLine: 5, generatedColumn: 0, sourceIndex: 1, originalLine: 8, originalColumn: 0, nameIndex: -1 },
  ];
  const encoded = encodeMappings(segments);
  expect(decodeMappings(encoded)).toEqual(segments);
  // 再编码是稳定的
  expect(encodeMappings(decodeMappings(encoded))).toBe(encoded);
});

it('keeps segment meaning when the name table is sorted during re-encode', () => {
  const map = parseSourceMap({
    version: 3,
    sources: ['a.ts'],
    names: ['zebra', 'apple', 'mango'],
    mappings: encodeMappings([
      { generatedLine: 0, generatedColumn: 0, sourceIndex: 0, originalLine: 0, originalColumn: 0, nameIndex: 0 },
      { generatedLine: 0, generatedColumn: 6, sourceIndex: 0, originalLine: 1, originalColumn: 0, nameIndex: 1 },
      { generatedLine: 0, generatedColumn: 12, sourceIndex: 0, originalLine: 2, originalColumn: 0, nameIndex: 2 },
    ]),
  });
  const sorted = encodeSourceMap(map, { sortNames: true });
  expect(sorted.names).toEqual(['apple', 'mango', 'zebra']);
  const reparsed = parseSourceMap(sorted);
  for (const [column, expected] of [[0, 'zebra'], [6, 'apple'], [12, 'mango']] as const) {
    const segment = lookupSegment(reparsed.segments, 0, column)!;
    expect(reparsed.names[segment.nameIndex]).toBe(expected);
  }
});
