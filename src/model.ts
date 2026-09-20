import { decodeMappings, encodeMappings } from './vlq.js';

/** 解码后的 mappings 段。行、列均为 0 起始。 */
export interface DecodedSegment {
  generatedLine: number;
  generatedColumn: number;
  /** -1 表示未映射段（无源信息）。 */
  sourceIndex: number;
  originalLine: number;
  originalColumn: number;
  /** -1 表示该段无显式名称。 */
  nameIndex: number;
}

export interface RawSourceMap {
  version: 3;
  sources: (string | null)[];
  names?: string[];
  mappings: string;
  sourcesContent?: (string | null)[];
  file?: string;
}

/** 内存中的 source map：段按 (generatedLine, generatedColumn) 升序排列。 */
export interface SourceMap {
  sources: (string | null)[];
  names: string[];
  segments: DecodedSegment[];
}

/** 名称表：按精确字符串去重（大小写敏感，空字符串是独立条目）。 */
export class NameTable {
  #indexByName = new Map<string, number>();
  #names: string[] = [];

  /** 返回该名称的稳定索引；相同字符串复用同一索引。 */
  add(name: string): number {
    const existing = this.#indexByName.get(name);
    if (existing !== undefined) return existing;
    const index = this.#names.length;
    this.#names.push(name);
    this.#indexByName.set(name, index);
    return index;
  }

  has(name: string): boolean {
    return this.#indexByName.has(name);
  }

  indexOf(name: string): number | undefined {
    return this.#indexByName.get(name);
  }

  get size(): number {
    return this.#names.length;
  }

  toArray(): string[] {
    return [...this.#names];
  }
}

/** 从已有部分构造 SourceMap，段会被排序以保证后续二分查找正确。 */
export function createSourceMap(init: {
  sources: (string | null)[];
  names?: string[];
  segments: DecodedSegment[];
}): SourceMap {
  return {
    sources: [...init.sources],
    names: [...(init.names ?? [])],
    segments: [...init.segments].sort(
      (a, b) => a.generatedLine - b.generatedLine || a.generatedColumn - b.generatedColumn,
    ),
  };
}

export function parseSourceMap(raw: RawSourceMap): SourceMap {
  if (raw.version !== 3) throw new Error(`Unsupported source map version: ${raw.version}`);
  return {
    sources: [...raw.sources],
    names: [...(raw.names ?? [])],
    segments: decodeMappings(raw.mappings),
  };
}

export interface EncodeOptions {
  /**
   * 为 true 时按字典序重排名称表。所有段的 nameIndex 会同步重映射，
   * 因此重编码不会改变任何段解析出的名称。
   */
  sortNames?: boolean;
}

export function encodeSourceMap(map: SourceMap, options: EncodeOptions = {}): RawSourceMap {
  let names = [...map.names];
  let segments = map.segments;
  if (options.sortNames) {
    const order = map.names
      .map((name, index) => ({ name, index }))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const remap = new Array<number>(map.names.length);
    order.forEach((entry, newIndex) => {
      remap[entry.index] = newIndex;
    });
    names = order.map((entry) => entry.name);
    segments = segments.map((segment) =>
      segment.nameIndex >= 0 ? { ...segment, nameIndex: remap[segment.nameIndex] } : segment,
    );
  }
  return {
    version: 3,
    sources: [...map.sources],
    names,
    mappings: encodeMappings(segments),
  };
}

interface Positioned {
  generatedLine: number;
  generatedColumn: number;
}

/**
 * 在同一生成行内做“最大下界”查找：返回该行中 generatedColumn <= column 的最后一个项。
 * 只按位置匹配，绝不跨段借用名称。
 */
export function greatestLowerBound<T extends Positioned>(
  items: readonly T[],
  line: number,
  column: number,
): T | null {
  let low = 0;
  let high = items.length - 1;
  let result = -1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const item = items[mid];
    if (item.generatedLine < line || (item.generatedLine === line && item.generatedColumn <= column)) {
      if (item.generatedLine === line) result = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return result >= 0 ? items[result] : null;
}

/** 在某一层的段列表中按生成位置查找段。 */
export function lookupSegment(
  segments: readonly DecodedSegment[],
  line: number,
  column: number,
): DecodedSegment | null {
  return greatestLowerBound(segments, line, column);
}
