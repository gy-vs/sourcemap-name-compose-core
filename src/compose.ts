import { SegmentMap } from './segment-map.js';
import type { ChainLink, ComposedSegment, Diagnosis, Segment } from './types.js';

/**
 * Composes a chain of maps (index 0 = closest to the generated output, last =
 * closest to the original source) into a single map straight to the original
 * source. Every composed segment carries its full mapping chain as provenance.
 *
 * Name policy: walking the chain from the generated side towards the original
 * source, the first explicit name wins — the segment's own explicit name
 * first, then explicit names from more original layers. A name is "explicit"
 * when it is not undefined; the empty string counts. Names are never borrowed
 * from adjacent segments: only links on this segment's own chain contribute.
 */
export function composeMaps(maps: readonly SegmentMap[]): ComposedMap {
  if (maps.length === 0) return new ComposedMap([]);
  const segments: ComposedSegment[] = [];
  for (const start of maps[0].segments()) {
    const chain: ChainLink[] = [];
    let current: Segment | null = start;
    for (let layer = 0; current !== null; layer++) {
      if (current.source === undefined) {
        chain.push({ layer, name: current.name }); // terminal: unmapped at this layer
        break;
      }
      chain.push({
        layer,
        source: current.source,
        originalLine: current.originalLine,
        originalColumn: current.originalColumn,
        name: current.name,
      });
      const next = maps[layer + 1];
      if (next === undefined) break;
      current = next.lookup(current.originalLine!, current.originalColumn!);
    }
    segments.push(composeSegment(start, chain));
  }
  return new ComposedMap(segments);
}

function composeSegment(start: Segment, chain: ChainLink[]): ComposedSegment {
  const base = { generatedLine: start.generatedLine, generatedColumn: start.generatedColumn, chain };
  const mapped = chain.filter((link) => link.source !== undefined);
  const last = mapped.at(-1);
  if (last === undefined) return base; // unmapped: no source anywhere on the chain
  const name = mapped.map((link) => link.name).find((candidate) => candidate !== undefined);
  return {
    ...base,
    source: last.source,
    originalLine: last.originalLine,
    originalColumn: last.originalColumn,
    name,
  };
}

function diagnose(segment: ComposedSegment): Diagnosis {
  const candidates = segment.chain.flatMap((link) =>
    link.name === undefined ? [] : [{ layer: link.layer, source: link.source, name: link.name }],
  );
  const distinct = new Set(candidates.map((candidate) => candidate.name));
  return { segment, candidates, resolved: segment.name, conflict: distinct.size > 1 };
}

export class ComposedMap {
  #segments: ComposedSegment[];

  constructor(segments: readonly ComposedSegment[]) {
    this.#segments = [...segments].sort(
      (a, b) => a.generatedLine - b.generatedLine || a.generatedColumn - b.generatedColumn,
    );
  }

  /** Greatest-lower-bound lookup on the given line; the result includes the full chain. */
  lookup(line: number, column: number): ComposedSegment | null {
    let best: ComposedSegment | null = null;
    for (const segment of this.#segments) {
      if (segment.generatedLine === line && segment.generatedColumn <= column) best = segment;
    }
    return best;
  }

  /** Diagnostics: the chain, every layer's name candidates, and the resolved name. */
  explain(line: number, column: number): Diagnosis | null {
    const segment = this.lookup(line, column);
    return segment === null ? null : diagnose(segment);
  }

  /** All segments whose layers record conflicting (distinct) explicit names. */
  conflicts(): Diagnosis[] {
    return this.#segments.map(diagnose).filter((diagnosis) => diagnosis.conflict);
  }

  segments(): ComposedSegment[] {
    return [...this.#segments];
  }

  sources(): string[] {
    const mapped = this.#segments.flatMap((segment) => (segment.source === undefined ? [] : [segment.source]));
    return [...new Set(mapped)];
  }
}
