# Source map core

TypeScript library for mapping composition.

Run `npm install`, then `npm test` and `npm run build`.

## Multi-stage composition with name propagation

`composeSourceMaps([final, ..., original])` composes a chain of source maps
(minify → transpile → bundle → original). `maps[0]` is the most-generated
layer; later layers are closer to the original source.

Every `lookup(line, column)` on the composed map returns a `ComposedMapping`
carrying the full mapping `chain` — one `ChainLink` per layer — as provenance
evidence, including when segments split (one original symbol → many generated
segments) or merge (many symbols → one generated segment).

### Name resolution policy

- The explicit name on the current (most-generated) segment wins.
- Otherwise the first explicit name walking the chain toward the original
  layer is inherited. An empty string counts as an explicit name.
- Names are only inherited along the chain — never guessed from adjacent
  segments in the same layer.
- Segments whose chain does not reach the original layer (unmapped segment,
  or no matching segment in the next layer) are unmapped and carry no name.

`composed.diagnostics()` lists per-layer candidate names for every mapping
that has any, flagging `conflict: true` when layers disagree.

### Name table and re-encoding

`NameTable` dedups by exact string (case-sensitive; `''` is a distinct
entry). `composed.toSourceMap()` produces segments whose `nameIndex` always
points at a valid table entry (`-1` when nameless). `encodeSourceMap(map,
{ sortNames: true })` re-sorts the name table while remapping every
`nameIndex`, so re-encoding never changes what a segment means.
