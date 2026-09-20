import { expect, it } from 'vitest';
import {
  NameTable,
  composeSourceMaps,
  createSourceMap,
  encodeSourceMap,
  lookupSegment,
  parseSourceMap,
  type DecodedSegment,
  type SourceMap,
} from '../src/index.js';

function mapped(
  generatedLine: number,
  generatedColumn: number,
  originalLine: number,
  originalColumn: number,
  sourceIndex = 0,
  nameIndex = -1,
): DecodedSegment {
  return { generatedLine, generatedColumn, sourceIndex, originalLine, originalColumn, nameIndex };
}

function unmapped(generatedLine: number, generatedColumn: number): DecodedSegment {
  return { generatedLine, generatedColumn, sourceIndex: -1, originalLine: -1, originalColumn: -1, nameIndex: -1 };
}

/**
 * 三层链：minified → bundle → transpiled → original。
 * - final 段 (0,0) 显式名 't'；(0,5) 无名，与 (0,0) 指向同一 bundle 段（拆分）；
 *   (0,12) 无名，指向 bundle (0,10)；(0,18) 未映射。
 * - mid 段 (0,0) 显式名 'renamed'；(0,10) 无名。
 * - orig 段 (0,0) 显式名 'calculate'；(0,20) 显式名 'helper'。
 */
function buildChain(): SourceMap[] {
  const finalMap = createSourceMap({
    sources: ['bundle.js'],
    names: ['t'],
    segments: [
      mapped(0, 0, 0, 0, 0, 0),
      mapped(0, 5, 0, 0),
      mapped(0, 12, 0, 10),
      unmapped(0, 18),
    ],
  });
  const midMap = createSourceMap({
    sources: ['transpiled.js'],
    names: ['renamed'],
    segments: [
      mapped(0, 0, 0, 0, 0, 0),
      mapped(0, 10, 0, 20),
    ],
  });
  const origMap = createSourceMap({
    sources: ['src/original.ts'],
    names: ['calculate', 'helper'],
    segments: [
      mapped(0, 0, 10, 4, 0, 0),
      mapped(0, 20, 20, 4, 0, 1),
    ],
  });
  return [finalMap, midMap, origMap];
}

it('prefers the explicit name on the current segment over more original layers', () => {
  const composed = composeSourceMaps(buildChain());
  const mapping = composed.lookup(0, 0)!;
  expect(mapping.name).toBe('t');
  expect(mapping.nameLayer).toBe(0);
  expect(mapping.source).toBe('src/original.ts');
  expect(mapping.originalLine).toBe(10);
  expect(mapping.originalColumn).toBe(4);
});

it('returns the full mapping chain on every lookup', () => {
  const composed = composeSourceMaps(buildChain());
  const mapping = composed.lookup(0, 0)!;
  expect(mapping.chain).toEqual([
    { layer: 0, generatedLine: 0, generatedColumn: 0, source: 'bundle.js', originalLine: 0, originalColumn: 0, name: 't' },
    { layer: 1, generatedLine: 0, generatedColumn: 0, source: 'transpiled.js', originalLine: 0, originalColumn: 0, name: 'renamed' },
    { layer: 2, generatedLine: 0, generatedColumn: 0, source: 'src/original.ts', originalLine: 10, originalColumn: 4, name: 'calculate' },
  ]);
});

it('inherits a middle-layer rename when the current segment has no name', () => {
  const composed = composeSourceMaps(buildChain());
  const mapping = composed.lookup(0, 5)!;
  expect(mapping.name).toBe('renamed');
  expect(mapping.nameLayer).toBe(1);
  // 拆分证据：与 (0,0) 段共享同一个中间层段和同一个原始符号
  const sibling = composed.lookup(0, 0)!;
  expect(mapping.chain[1]).toEqual(sibling.chain[1]);
  expect(mapping.chain[2]).toEqual(sibling.chain[2]);
});

it('inherits from the most original layer when intermediate layers are nameless', () => {
  const composed = composeSourceMaps(buildChain());
  const mapping = composed.lookup(0, 12)!;
  expect(mapping.name).toBe('helper');
  expect(mapping.nameLayer).toBe(2);
  expect(mapping.originalLine).toBe(20);
});

it('keeps unmapped segments unmapped and nameless', () => {
  const composed = composeSourceMaps(buildChain());
  const mapping = composed.lookup(0, 18)!;
  expect(mapping.source).toBeNull();
  expect(mapping.name).toBeUndefined();
  expect(mapping.nameIndex).toBe(-1);
  expect(mapping.chain).toHaveLength(1);
  expect(mapping.chain[0].source).toBeNull();
});

it('treats segments as unmapped when the trace stops before the original layer', () => {
  const finalMap = createSourceMap({
    sources: ['mid.js'],
    names: ['local'],
    segments: [
      mapped(0, 0, 3, 0, 0, 0), // mid 层第 3 行没有任何段
      mapped(0, 8, 0, 10, 0, 0), // mid 层 (0,10) 是未映射段
    ],
  });
  const midMap = createSourceMap({
    sources: ['original.ts'],
    names: [],
    segments: [mapped(0, 0, 0, 0), unmapped(0, 10)],
  });
  const origMap = createSourceMap({
    sources: ['original.ts'],
    names: ['foo'],
    segments: [mapped(0, 0, 0, 0, 0, 0)],
  });
  const composed = composeSourceMaps([finalMap, midMap, origMap]);
  const noSegment = composed.lookup(0, 0)!;
  expect(noSegment.source).toBeNull();
  expect(noSegment.name).toBeUndefined();
  expect(noSegment.chain).toHaveLength(1);
  const hitUnmapped = composed.lookup(0, 8)!;
  expect(hitUnmapped.source).toBeNull();
  expect(hitUnmapped.name).toBeUndefined();
  expect(hitUnmapped.chain).toHaveLength(2);
  // 来源证据仍然保留：候选名称可通过诊断查看
  const diagnostics = composed.diagnostics();
  expect(diagnostics.map((entry) => entry.candidates)).toEqual([
    [{ layer: 0, name: 'local', source: 'mid.js' }],
    [{ layer: 0, name: 'local', source: 'mid.js' }],
  ]);
});

it('resolves a split symbol to one deduped name entry for all generated segments', () => {
  const composed = composeSourceMaps(buildChain());
  const first = composed.lookup(0, 0)!;
  const second = composed.lookup(0, 5)!;
  // 名称表精确去重：'renamed' 只出现一次，两个段共享同一索引
  expect(composed.names).toEqual(['t', 'renamed', 'helper']);
  expect(second.nameIndex).toBe(composed.names.indexOf('renamed'));
  expect(composed.names.filter((name) => name === 'renamed')).toHaveLength(1);
  expect(first.nameIndex).not.toBe(second.nameIndex);
});

it('exposes per-layer candidates for merged symbols via diagnostics', () => {
  // 压缩层把 foo/bar 两个符号合并为一个生成段 't'
  const finalMap = createSourceMap({
    sources: ['minified.js'],
    names: [],
    segments: [mapped(0, 0, 0, 0)],
  });
  const minLayer = createSourceMap({
    sources: ['transpiled.js'],
    names: ['t'],
    segments: [mapped(0, 0, 0, 0, 0, 0)],
  });
  const origMap = createSourceMap({
    sources: ['app.ts'],
    names: ['foo', 'bar'],
    segments: [
      mapped(0, 0, 0, 0, 0, 0),
      mapped(0, 10, 0, 20, 0, 1),
    ],
  });
  const composed = composeSourceMaps([finalMap, minLayer, origMap]);
  const mapping = composed.lookup(0, 0)!;
  expect(mapping.name).toBe('t');
  expect(mapping.nameLayer).toBe(1);
  const [diagnostic] = composed.diagnostics();
  expect(diagnostic.conflict).toBe(true);
  expect(diagnostic.candidates).toEqual([
    { layer: 1, name: 't', source: 'transpiled.js' },
    { layer: 2, name: 'foo', source: 'app.ts' },
  ]);
});

it('treats an empty string as an explicit name, not as a missing one', () => {
  const finalMap = createSourceMap({
    sources: ['mid.js'],
    names: [''],
    segments: [
      mapped(0, 0, 0, 0, 0, 0), // 显式空字符串名
      mapped(0, 8, 0, 0), // 无名，应继承中间层的空字符串
    ],
  });
  const midMap = createSourceMap({
    sources: ['original.ts'],
    names: [''],
    segments: [mapped(0, 0, 0, 0, 0, 0)],
  });
  const origMap = createSourceMap({
    sources: ['original.ts'],
    names: ['calculate'],
    segments: [mapped(0, 0, 0, 0, 0, 0)],
  });
  const composed = composeSourceMaps([finalMap, midMap, origMap]);
  expect(composed.lookup(0, 0)!.name).toBe('');
  expect(composed.lookup(0, 0)!.nameLayer).toBe(0);
  expect(composed.lookup(0, 8)!.name).toBe('');
  expect(composed.lookup(0, 8)!.nameLayer).toBe(1);
  // 空字符串在名称表中是独立条目，且只去重为一条
  expect(composed.names).toEqual(['']);
});

it('never borrows a name from an adjacent segment in the same layer', () => {
  const finalMap = createSourceMap({
    sources: ['mid.js'],
    names: [],
    segments: [mapped(0, 0, 0, 8)], // 指向 mid 层无名段 (0,8)
  });
  const midMap = createSourceMap({
    sources: ['original.ts'],
    names: ['neighbor'],
    segments: [
      mapped(0, 0, 0, 0, 0, 0), // 相邻段有名 'neighbor'
      mapped(0, 8, 0, 4), // 目标段本身无名
    ],
  });
  const origMap = createSourceMap({
    sources: ['original.ts'],
    names: [],
    segments: [mapped(0, 0, 0, 0), mapped(0, 4, 0, 9)],
  });
  const composed = composeSourceMaps([finalMap, midMap, origMap]);
  const mapping = composed.lookup(0, 0)!;
  expect(mapping.name).toBeUndefined();
  expect(mapping.nameIndex).toBe(-1);
  expect(mapping.originalColumn).toBe(9);
  expect(composed.names).toEqual([]);
  expect(composed.diagnostics()).toEqual([]);
});

it('reports nameless chains as nameless without diagnostics entries', () => {
  const maps = buildChain().map((map) => ({ ...map, names: [], segments: map.segments.map((segment) => ({ ...segment, nameIndex: -1 })) }));
  const composed = composeSourceMaps(maps);
  const mapping = composed.lookup(0, 0)!;
  expect(mapping.name).toBeUndefined();
  expect(mapping.nameLayer).toBeNull();
  expect(mapping.nameIndex).toBe(-1);
  expect(composed.diagnostics()).toEqual([]);
});

it('flags conflicts only when layers disagree on the name', () => {
  const composed = composeSourceMaps(buildChain());
  const diagnostics = composed.diagnostics();
  const byColumn = new Map(diagnostics.map((entry) => [entry.generatedColumn, entry]));
  expect(byColumn.get(0)!.conflict).toBe(true); // t vs renamed vs calculate
  expect(byColumn.get(0)!.candidates.map((candidate) => candidate.name)).toEqual(['t', 'renamed', 'calculate']);
  expect(byColumn.get(5)!.conflict).toBe(true); // renamed vs calculate
  expect(byColumn.get(12)!.conflict).toBe(false); // 只有 helper
  expect(byColumn.get(12)!.resolvedLayer).toBe(2);
  expect(byColumn.has(18)).toBe(false); // 未映射段无候选
});

it('produces valid name indices that survive re-encoding and name-table sorting', () => {
  const composed = composeSourceMaps(buildChain());
  const map = composed.toSourceMap();
  for (const segment of map.segments) {
    expect(segment.sourceIndex).toBeLessThan(map.sources.length);
    if (segment.sourceIndex === -1) {
      expect(segment.nameIndex).toBe(-1);
      continue;
    }
    if (segment.nameIndex !== -1) {
      expect(segment.nameIndex).toBeGreaterThanOrEqual(0);
      expect(segment.nameIndex).toBeLessThan(map.names.length);
    }
  }
  // 段含义与组合结果一致
  for (const mapping of composed.mappings) {
    const segment = lookupSegment(map.segments, mapping.generatedLine, mapping.generatedColumn)!;
    const name = segment.nameIndex === -1 ? undefined : map.names[segment.nameIndex];
    expect(name).toBe(mapping.name);
  }
  // 排序名称表后重编码，解码出的名称不变
  const sortedRaw = encodeSourceMap(map, { sortNames: true });
  expect(sortedRaw.names).toEqual(['helper', 'renamed', 't']);
  const reparsed = parseSourceMap(sortedRaw);
  for (const mapping of composed.mappings) {
    const segment = lookupSegment(reparsed.segments, mapping.generatedLine, mapping.generatedColumn)!;
    const name = segment.nameIndex === -1 ? undefined : reparsed.names[segment.nameIndex];
    expect(name).toBe(mapping.name);
  }
  // 不排序的重编码往返后段完全一致
  const roundTripped = parseSourceMap(encodeSourceMap(map));
  expect(roundTripped.segments).toEqual(map.segments);
  expect(roundTripped.names).toEqual(map.names);
});

it('composes maps through the full encode/parse pipeline', () => {
  const raws = buildChain().map((map) => encodeSourceMap(map));
  const composed = composeSourceMaps(raws.map((raw) => parseSourceMap(raw)));
  expect(composed.lookup(0, 0)!.name).toBe('t');
  expect(composed.lookup(0, 5)!.name).toBe('renamed');
  expect(composed.lookup(0, 12)!.name).toBe('helper');
  expect(composed.lookup(0, 18)!.source).toBeNull();
  // 组合输出再编码仍是合法 source map
  const reparsed = parseSourceMap(composed.encode());
  expect(lookupSegment(reparsed.segments, 0, 5)!.nameIndex).toBe(reparsed.names.indexOf('renamed'));
});

it('dedups the name table by exact string', () => {
  const table = new NameTable();
  expect(table.add('foo')).toBe(0);
  expect(table.add('foo')).toBe(0);
  expect(table.add('Foo')).toBe(1);
  expect(table.add('')).toBe(2);
  expect(table.add('')).toBe(2);
  expect(table.size).toBe(3);
  expect(table.toArray()).toEqual(['foo', 'Foo', '']);
});
