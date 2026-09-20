export type Segment = {
  generatedLine: number; // 1-based
  generatedColumn: number; // 0-based
  source?: string; // undefined => generated code with no source mapping
  originalLine?: number; // 1-based, present iff source is
  originalColumn?: number; // 0-based, present iff source is
  name?: string; // explicit name recorded at this layer; undefined => absent
};

export type ChainLink = {
  layer: number; // 0 = map closest to the generated output
  source?: string; // source this link resolves to; undefined => chain ends unmapped
  originalLine?: number;
  originalColumn?: number;
  name?: string; // explicit name recorded by this layer
};

export type ComposedSegment = {
  generatedLine: number;
  generatedColumn: number;
  source?: string; // deepest resolved source along the chain
  originalLine?: number;
  originalColumn?: number;
  name?: string; // resolved per the name policy (see composeMaps)
  chain: ChainLink[]; // full provenance, generated side first
};

export type NameCandidate = { layer: number; source?: string; name: string };

export type Diagnosis = {
  segment: ComposedSegment;
  candidates: NameCandidate[]; // every explicit name on the chain, in chain order
  resolved?: string;
  conflict: boolean; // more than one distinct explicit name across layers
};

export type EncodedSourceMap = {
  version: 3;
  sources: string[];
  names: string[];
  mappings: string; // base64 VLQ
};

export type DecodedSegment = {
  generatedLine: number;
  generatedColumn: number;
  source?: string;
  originalLine?: number;
  originalColumn?: number;
  name?: string;
};
