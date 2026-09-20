import type { Segment } from './types.js';

export class SegmentMap {
  #segments: Segment[] = [];

  add(segment: Segment): this {
    const mapped = segment.source !== undefined;
    const positioned = segment.originalLine !== undefined && segment.originalColumn !== undefined;
    if (mapped !== positioned) {
      throw new Error('segment source and original position must be provided together');
    }
    this.#segments.push(segment);
    this.#segments.sort((a, b) => a.generatedLine - b.generatedLine || a.generatedColumn - b.generatedColumn);
    return this;
  }

  /** Greatest-lower-bound lookup on the given line; null when no segment covers the column. */
  lookup(line: number, column: number): Segment | null {
    let best: Segment | null = null;
    for (const segment of this.#segments) {
      if (segment.generatedLine === line && segment.generatedColumn <= column) best = segment;
    }
    return best;
  }

  segments(): Segment[] {
    return [...this.#segments];
  }

  sources(): string[] {
    const mapped = this.#segments.filter((item) => item.source !== undefined);
    return [...new Set(mapped.map((item) => item.source!.split('/').at(-1)!))];
  }
}
