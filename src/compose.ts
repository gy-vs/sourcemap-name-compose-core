import type { DecodedSegment, RawSourceMap, SourceMap } from './model.js';
import {
  NameTable,
  encodeSourceMap,
  greatestLowerBound,
  lookupSegment,
  type EncodeOptions,
} from './model.js';

/** 映射链上的一环：某一层中匹配到的段及其指向的源。 */
export interface ChainLink {
  /** 0 为最终生成层（最靠近输出），数值越大越接近原始源。 */
  layer: number;
  generatedLine: number;
  generatedColumn: number;
  /** 该段指向的源文件；未映射段为 null。 */
  source: string | null;
  originalLine: number | null;
  originalColumn: number | null;
  /** 该层段上的显式名称；无显式名称为 undefined（空字符串属于显式名称）。 */
  name: string | undefined;
}

/** 组合后的映射：每次查询都携带完整映射链作为来源证据。 */
export interface ComposedMapping {
  generatedLine: number;
  generatedColumn: number;
  /** 最原始层的源文件；链未到达原始层或未映射时为 null。 */
  source: string | null;
  originalLine: number | null;
  originalColumn: number | null;
  /**
   * 按策略解析出的最终名称：当前段显式名称优先，
   * 否则取同一链上更原始层的第一个显式名称。未映射段不带名称。
   */
  name: string | undefined;
  /** 提供最终名称的层；无名称为 null。 */
  nameLayer: number | null;
  /** 最终名称在组合名称表中的索引；无名称为 -1。 */
  nameIndex: number;
  /** 完整映射链，从最终生成层到最原始层依次排列。 */
  chain: ChainLink[];
}

/** 名称诊断：某一生成段在各层上的显式候选名称。 */
export interface NameDiagnostic {
  generatedLine: number;
  generatedColumn: number;
  resolvedName: string | undefined;
  resolvedLayer: number | null;
  /** 各层候选，按从生成层到原始层的顺序。 */
  candidates: { layer: number; name: string; source: string | null }[];
  /** 各层候选存在不同名称（精确字符串比较）时为 true。 */
  conflict: boolean;
}

export class ComposedSourceMap {
  readonly mappings: readonly ComposedMapping[];
  /** 组合输出引用到的原始源（按首次出现顺序去重）。 */
  readonly sources: readonly string[];
  #names: NameTable;

  constructor(mappings: ComposedMapping[], sources: string[], names: NameTable) {
    this.mappings = mappings;
    this.sources = sources;
    this.#names = names;
  }

  /** 组合后的名称表（精确字符串去重，按首次出现排序）。 */
  get names(): string[] {
    return this.#names.toArray();
  }

  /** 按生成位置查询（同行最大下界），返回携带完整映射链的组合映射。 */
  lookup(line: number, column: number): ComposedMapping | null {
    return greatestLowerBound(this.mappings, line, column);
  }

  /** 诊断：所有至少有一个候选名称的映射，冲突时 conflict 为 true。 */
  diagnostics(): NameDiagnostic[] {
    const result: NameDiagnostic[] = [];
    for (const mapping of this.mappings) {
      const candidates = mapping.chain
        .filter((link) => link.name !== undefined)
        .map((link) => ({ layer: link.layer, name: link.name as string, source: link.source }));
      if (candidates.length === 0) continue;
      result.push({
        generatedLine: mapping.generatedLine,
        generatedColumn: mapping.generatedColumn,
        resolvedName: mapping.name,
        resolvedLayer: mapping.nameLayer,
        candidates,
        conflict: new Set(candidates.map((candidate) => candidate.name)).size > 1,
      });
    }
    return result;
  }

  /** 导出为 SourceMap：nameIndex 均指向组合名称表内的有效条目，未映射段为 -1。 */
  toSourceMap(): SourceMap {
    const sourceIndex = new Map<string, number>(this.sources.map((source, index) => [source, index]));
    const segments: DecodedSegment[] = this.mappings.map((mapping) => ({
      generatedLine: mapping.generatedLine,
      generatedColumn: mapping.generatedColumn,
      sourceIndex: mapping.source === null ? -1 : sourceIndex.get(mapping.source)!,
      originalLine: mapping.originalLine ?? -1,
      originalColumn: mapping.originalColumn ?? -1,
      nameIndex: mapping.source === null ? -1 : mapping.nameIndex,
    }));
    return { sources: [...this.sources], names: this.names, segments };
  }

  /** 直接编码为 raw source map；sortNames 只重排名称表，不改变段含义。 */
  encode(options?: EncodeOptions): RawSourceMap {
    return encodeSourceMap(this.toSourceMap(), options);
  }
}

/**
 * 组合多层 source map。maps[0] 是最终生成层（压缩/打包输出），
 * 越靠后的层越接近原始源。每个最终段沿链逐层回溯：
 * 名称解析只看链上各段的显式名称，绝不从同层相邻段猜测。
 */
export function composeSourceMaps(maps: SourceMap[]): ComposedSourceMap {
  if (maps.length === 0) throw new Error('composeSourceMaps requires at least one map');
  const names = new NameTable();
  const sources: string[] = [];
  const sourceSet = new Set<string>();
  const mappings: ComposedMapping[] = [];

  for (const first of maps[0].segments) {
    const chain: ChainLink[] = [];
    let current: DecodedSegment = first;
    for (let layer = 0; ; layer++) {
      const map = maps[layer];
      const mapped = current.sourceIndex >= 0;
      chain.push({
        layer,
        generatedLine: current.generatedLine,
        generatedColumn: current.generatedColumn,
        source: mapped ? (map.sources[current.sourceIndex] ?? null) : null,
        originalLine: mapped ? current.originalLine : null,
        originalColumn: mapped ? current.originalColumn : null,
        name: current.nameIndex >= 0 ? map.names[current.nameIndex] : undefined,
      });
      if (!mapped || layer === maps.length - 1) break;
      const next = lookupSegment(maps[layer + 1].segments, current.originalLine, current.originalColumn);
      if (!next) break;
      current = next;
    }

    const last = chain[chain.length - 1];
    // 只有链到达最原始层且该段已映射，组合段才有源。
    const reachedOriginal = chain.length === maps.length && last.source !== null;

    // 名称策略：从生成层向原始层取第一个显式名称（空字符串算显式）。
    let name: string | undefined;
    let nameLayer: number | null = null;
    if (reachedOriginal) {
      for (const link of chain) {
        if (link.name !== undefined) {
          name = link.name;
          nameLayer = link.layer;
          break;
        }
      }
    }

    const nameIndex = name !== undefined ? names.add(name) : -1;
    if (reachedOriginal && !sourceSet.has(last.source!)) {
      sourceSet.add(last.source!);
      sources.push(last.source!);
    }
    mappings.push({
      generatedLine: first.generatedLine,
      generatedColumn: first.generatedColumn,
      source: reachedOriginal ? last.source : null,
      originalLine: reachedOriginal ? last.originalLine : null,
      originalColumn: reachedOriginal ? last.originalColumn : null,
      name,
      nameLayer,
      nameIndex,
      chain,
    });
  }
  return new ComposedSourceMap(mappings, sources, names);
}
