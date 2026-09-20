import { describe, expect, it } from 'vitest';
import {
  ComposedMap,
  NameTable,
  SegmentMap,
  composeMaps,
  decodeMap,
  encodeMap,
} from '../src/index.js';
import type { EncodedSourceMap } from '../src/index.js';

it('looks up a segment', () => {
  const x = new SegmentMap();
  x.add({ generatedLine: 1, generatedColumn: 0, source: 'a.ts', originalLine: 1, originalColumn: 0 });
  expect(x.lookup(1, 4)?.source).toBe('a.ts');
});

describe('NameTable', () => {
  it('dedups by exact string only', () => {
    const table = new NameTable();
    expect(table.intern('name')).toBe(0);
    expect(table.intern('name')).toBe(0); // identical string dedups
    expect(table.intern('name ')).toBe(1); // trailing space is a different name
    expect(table.intern('')).toBe(2); // empty string is a real, distinct name
    expect(table.intern('Name')).toBe(3); // case-sensitive
    expect(table.names).toEqual(['name', 'name ', '', 'Name']);
  });

  it('sorted() returns a remap that keeps every index pointing at the same string', () => {
    const table = new NameTable();
    const zeta = table.intern('zeta');
    const empty = table.intern('');
    const alpha = table.intern('alpha');
    const { names, remap } = table.sorted();
    expect(names).toEqual(['', 'alpha', 'zeta']);
    expect(names[remap[zeta]]).toBe('zeta');
    expect(names[remap[empty]]).toBe('');
    expect(names[remap[alpha]]).toBe('alpha');
  });
});

describe('composeMaps name policy', () => {
  // bundle -> min -> trans -> src, every layer renames the symbol
  const threeLayers = (bundleName?: string) => {
    const bundle = new SegmentMap();
    bundle.add({ generatedLine: 1, generatedColumn: 0, source: 'min.js', originalLine: 1, originalColumn: 4, name: bundleName });
    const min = new SegmentMap();
    min.add({ generatedLine: 1, generatedColumn: 0, source: 'trans.js', originalLine: 2, originalColumn: 10, name: 't' });
    const trans = new SegmentMap();
    trans.add({ generatedLine: 2, generatedColumn: 8, source: 'src.ts', originalLine: 5, originalColumn: 2, name: 'originalName' });
    return composeMaps([bundle, min, trans]);
  };

  it("resolves through every layer and prefers the current segment's explicit name", () => {
    const composed = threeLayers('e');
    const segment = composed.lookup(1, 0)!;
    expect(segment.source).toBe('src.ts');
    expect(segment.originalLine).toBe(5);
    expect(segment.originalColumn).toBe(2);
    expect(segment.name).toBe('e'); // current segment's explicit name wins
    expect(segment.chain.map((link) => link.source)).toEqual(['min.js', 'trans.js', 'src.ts']);
    expect(segment.chain.map((link) => link.name)).toEqual(['e', 't', 'originalName']);
  });

  it('exposes per-layer candidates and the conflict through the diagnostics API', () => {
    const composed = threeLayers('e');
    const diagnosis = composed.explain(1, 0)!;
    expect(diagnosis.conflict).toBe(true);
    expect(diagnosis.resolved).toBe('e');
    expect(diagnosis.candidates).toEqual([
      { layer: 0, source: 'min.js', name: 'e' },
      { layer: 1, source: 'trans.js', name: 't' },
      { layer: 2, source: 'src.ts', name: 'originalName' },
    ]);
    expect(composed.conflicts()).toHaveLength(1);
    expect(composed.conflicts()[0].segment.generatedColumn).toBe(0);
  });

  it('inherits the nearest explicit name towards the original source when a layer lacks one', () => {
    const composed = threeLayers(undefined); // bundle segment has no name
    expect(composed.lookup(1, 0)!.name).toBe('t'); // layer 1 is the nearest explicit name
    const diagnosis = composed.explain(1, 0)!;
    expect(diagnosis.conflict).toBe(true); // 't' vs 'originalName' still inspectable
    expect(diagnosis.candidates.map((candidate) => candidate.name)).toEqual(['t', 'originalName']);
  });

  it('falls back to the deepest layer when only it records a name', () => {
    const bundle = new SegmentMap();
    bundle.add({ generatedLine: 1, generatedColumn: 0, source: 'min.js', originalLine: 1, originalColumn: 0 });
    const min = new SegmentMap();
    min.add({ generatedLine: 1, generatedColumn: 0, source: 'src.ts', originalLine: 3, originalColumn: 1, name: 'deep' });
    const composed = composeMaps([bundle, min]);
    expect(composed.lookup(1, 0)!.name).toBe('deep');
  });

  it('leaves the name undefined when no layer records one', () => {
    const bundle = new SegmentMap();
    bundle.add({ generatedLine: 1, generatedColumn: 0, source: 'min.js', originalLine: 1, originalColumn: 0 });
    const min = new SegmentMap();
    min.add({ generatedLine: 1, generatedColumn: 0, source: 'src.ts', originalLine: 3, originalColumn: 1 });
    const composed = composeMaps([bundle, min]);
    const segment = composed.lookup(1, 0)!;
    expect(segment.name).toBeUndefined();
    expect(composed.explain(1, 0)!.candidates).toEqual([]);
    expect(composed.conflicts()).toEqual([]);
  });

  it('treats the empty string as an explicit name, not as a missing one', () => {
    const composed = threeLayers('');
    const segment = composed.lookup(1, 0)!;
    expect(segment.name).toBe(''); // '' wins over 't' and 'originalName'
    const encoded = encodeMap(composed);
    expect(encoded.names).toEqual(['']); // interned exactly once
    expect(decodeMap(encoded)[0].name).toBe('');
  });

  it('never borrows a name from an adjacent segment', () => {
    const min = new SegmentMap();
    min.add({ generatedLine: 1, generatedColumn: 0, source: 'src.ts', originalLine: 1, originalColumn: 0, name: 'foo' });
    min.add({ generatedLine: 1, generatedColumn: 8, source: 'src.ts', originalLine: 9, originalColumn: 0 }); // unnamed
    const bundle = new SegmentMap();
    bundle.add({ generatedLine: 1, generatedColumn: 0, source: 'min.js', originalLine: 1, originalColumn: 2 }); // -> named segment
    bundle.add({ generatedLine: 1, generatedColumn: 6, source: 'min.js', originalLine: 1, originalColumn: 9 }); // -> unnamed segment
    const composed = composeMaps([bundle, min]);
    expect(composed.lookup(1, 0)!.name).toBe('foo');
    const neighbour = composed.lookup(1, 6)!;
    expect(neighbour.source).toBe('src.ts');
    expect(neighbour.originalLine).toBe(9);
    expect(neighbour.name).toBeUndefined(); // 'foo' from the adjacent segment must not leak over
  });
});

describe('composeMaps split and merge', () => {
  it('propagates one original symbol to every generated segment it was split into', () => {
    const trans = new SegmentMap();
    trans.add({ generatedLine: 1, generatedColumn: 0, source: 'src.ts', originalLine: 1, originalColumn: 0, name: 'sym' });
    const bundle = new SegmentMap();
    bundle.add({ generatedLine: 1, generatedColumn: 0, source: 'trans.js', originalLine: 1, originalColumn: 0 });
    bundle.add({ generatedLine: 1, generatedColumn: 10, source: 'trans.js', originalLine: 1, originalColumn: 3 });
    bundle.add({ generatedLine: 2, generatedColumn: 0, source: 'trans.js', originalLine: 1, originalColumn: 6 });
    const composed = composeMaps([bundle, trans]);
    const segments = composed.segments();
    expect(segments).toHaveLength(3);
    for (const segment of segments) {
      expect(segment.source).toBe('src.ts');
      expect(segment.originalLine).toBe(1);
      expect(segment.name).toBe('sym');
      expect(segment.chain).toHaveLength(2); // each split segment keeps its own provenance
    }
    expect(segments[1].chain[0].originalColumn).toBe(3); // evidence is per segment, not shared
    const encoded = encodeMap(composed);
    expect(encoded.names).toEqual(['sym']); // deduped to a single table entry
    expect(decodeMap(encoded).map((segment) => segment.name)).toEqual(['sym', 'sym', 'sym']);
  });

  it('keeps provenance when multiple symbols merge into one original position', () => {
    const bundle = new SegmentMap();
    bundle.add({ generatedLine: 1, generatedColumn: 0, source: 'min.js', originalLine: 1, originalColumn: 0, name: 'left' });
    bundle.add({ generatedLine: 1, generatedColumn: 8, source: 'min.js', originalLine: 1, originalColumn: 0 }); // same min target
    const min = new SegmentMap();
    min.add({ generatedLine: 1, generatedColumn: 0, source: 'src.ts', originalLine: 7, originalColumn: 0, name: 'merged' });
    const composed = composeMaps([bundle, min]);
    const [a, b] = composed.segments();
    expect([a.source, a.originalLine]).toEqual(['src.ts', 7]);
    expect([b.source, b.originalLine]).toEqual(['src.ts', 7]); // both converge on the same original
    expect(a.name).toBe('left'); // its own explicit name
    expect(b.name).toBe('merged'); // inherited from the more original layer
    expect(b.chain[0].originalColumn).toBe(0);
    expect(b.chain[1].name).toBe('merged'); // chain records where the name came from
    const diagnosis = composed.explain(1, 0)!;
    expect(diagnosis.candidates.map((candidate) => candidate.name)).toEqual(['left', 'merged']);
    expect(diagnosis.conflict).toBe(true);
  });
});

describe('composeMaps unmapped segments', () => {
  it('passes unmapped generated code through without a name', () => {
    const bundle = new SegmentMap();
    bundle.add({ generatedLine: 1, generatedColumn: 0, source: 'min.js', originalLine: 1, originalColumn: 0, name: 'x' });
    bundle.add({ generatedLine: 1, generatedColumn: 20, name: 'ghost' }); // unmapped, name kept only as evidence
    const min = new SegmentMap();
    min.add({ generatedLine: 1, generatedColumn: 0, source: 'src.ts', originalLine: 3, originalColumn: 0, name: 'y' });
    const composed = composeMaps([bundle, min]);
    const unmapped = composed.lookup(1, 20)!;
    expect(unmapped.source).toBeUndefined();
    expect(unmapped.name).toBeUndefined(); // unmapped segments carry no resolved name
    expect(unmapped.chain).toHaveLength(1);
    const diagnosis = composed.explain(1, 20)!;
    expect(diagnosis.candidates).toEqual([{ layer: 0, source: undefined, name: 'ghost' }]); // evidence preserved
    const decoded = decodeMap(encodeMap(composed));
    const decodedUnmapped = decoded.find((segment) => segment.generatedColumn === 20)!;
    expect(decodedUnmapped.source).toBeUndefined();
    expect(decodedUnmapped.name).toBeUndefined();
  });

  it('stops at the deepest resolved layer when a deeper map does not cover the position', () => {
    const bundle = new SegmentMap();
    bundle.add({ generatedLine: 1, generatedColumn: 0, source: 'min.js', originalLine: 5, originalColumn: 0 });
    const min = new SegmentMap();
    min.add({ generatedLine: 1, generatedColumn: 0, source: 'src.ts', originalLine: 1, originalColumn: 0 }); // line 5 uncovered
    const segment = composeMaps([bundle, min]).lookup(1, 0)!;
    expect(segment.source).toBe('min.js');
    expect(segment.originalLine).toBe(5);
    expect(segment.chain).toHaveLength(1);
  });

  it('records a terminal unmapped link when a deeper layer marks the region unmapped', () => {
    const bundle = new SegmentMap();
    bundle.add({ generatedLine: 1, generatedColumn: 0, source: 'min.js', originalLine: 1, originalColumn: 0 });
    const min = new SegmentMap();
    min.add({ generatedLine: 1, generatedColumn: 0 }); // explicitly unmapped region
    const segment = composeMaps([bundle, min]).lookup(1, 0)!;
    expect(segment.source).toBe('min.js'); // deepest *mapped* link wins
    expect(segment.chain).toHaveLength(2);
    expect(segment.chain[1].source).toBeUndefined();
  });
});

describe('encoding', () => {
  const composed = () => {
    const bundle = new SegmentMap();
    bundle.add({ generatedLine: 1, generatedColumn: 0, source: 'src.ts', originalLine: 1, originalColumn: 0, name: 'zeta' });
    bundle.add({ generatedLine: 1, generatedColumn: 5, source: 'src.ts', originalLine: 1, originalColumn: 5, name: '' });
    bundle.add({ generatedLine: 1, generatedColumn: 9, source: 'src.ts', originalLine: 2, originalColumn: 0, name: 'alpha' });
    bundle.add({ generatedLine: 2, generatedColumn: 0, source: 'src.ts', originalLine: 2, originalColumn: 4 }); // unnamed
    bundle.add({ generatedLine: 3, generatedColumn: 2 }); // unmapped
    return composeMaps([bundle]);
  };

  it('emits valid name indices that decode back to the same strings', () => {
    const encoded = encodeMap(composed());
    expect(encoded.names).toEqual(['zeta', '', 'alpha']); // first-appearance order, not sorted
    const decoded = decodeMap(encoded); // throws on any out-of-range index
    expect(decoded.map((segment) => segment.name)).toEqual(['zeta', '', 'alpha', undefined, undefined]);
    expect(decoded.map((segment) => [segment.generatedLine, segment.generatedColumn])).toEqual([
      [1, 0],
      [1, 5],
      [1, 9],
      [2, 0],
      [3, 2],
    ]);
  });

  it('re-encoding with a sorted names table does not change segment meaning', () => {
    const map = composed();
    const plain = encodeMap(map);
    const sorted = encodeMap(map, { sortNames: true });
    expect(sorted.names).toEqual(['', 'alpha', 'zeta']); // table sorted...
    expect(decodeMap(sorted)).toEqual(decodeMap(plain)); // ...but segments resolve identically
  });

  it('stays stable across a decode/re-encode round trip', () => {
    const reencode = (encoded: EncodedSourceMap): EncodedSourceMap => {
      const rebuilt = new SegmentMap();
      for (const segment of decodeMap(encoded)) rebuilt.add(segment);
      return encodeMap(composeMaps([rebuilt]));
    };
    const once = encodeMap(composed(), { sortNames: true });
    const twice = reencode(once);
    expect(decodeMap(twice)).toEqual(decodeMap(once));
  });

  it('round-trips multi-line maps with negative deltas', () => {
    const map = new SegmentMap();
    map.add({ generatedLine: 1, generatedColumn: 10, source: 'b.ts', originalLine: 5, originalColumn: 3, name: 'late' });
    map.add({ generatedLine: 2, generatedColumn: 0, source: 'a.ts', originalLine: 1, originalColumn: 0, name: 'early' });
    map.add({ generatedLine: 4, generatedColumn: 1, source: 'b.ts', originalLine: 2, originalColumn: 2, name: 'late' });
    const decoded = decodeMap(encodeMap(composeMaps([map])));
    expect(decoded).toEqual([
      { generatedLine: 1, generatedColumn: 10, source: 'b.ts', originalLine: 5, originalColumn: 3, name: 'late' },
      { generatedLine: 2, generatedColumn: 0, source: 'a.ts', originalLine: 1, originalColumn: 0, name: 'early' },
      { generatedLine: 4, generatedColumn: 1, source: 'b.ts', originalLine: 2, originalColumn: 2, name: 'late' },
    ]);
  });

  it('rejects corrupt name indices on decode', () => {
    const encoded = encodeMap(composed());
    expect(() => decodeMap({ ...encoded, names: [] })).toThrow(/name index/);
  });
});
