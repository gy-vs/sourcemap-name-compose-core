# Source map core

TypeScript library for mapping composition.

Run `npm install`, then `npm test` and `npm run build`.

## API

- `SegmentMap` — ordered segment container with greatest-lower-bound `lookup(line, column)`. Segments without a `source` are unmapped generated code.
- `composeMaps([mapA, mapB, ...])` — composes a chain of maps (index 0 = closest to the generated output, last = closest to the original source) into a `ComposedMap` straight to the original source.
- `ComposedMap.lookup(line, column)` — returns the composed segment including its full mapping `chain` (one link per layer, generated side first) as provenance.
- `ComposedMap.explain(line, column)` / `conflicts()` — diagnostics: every layer's name candidates, the resolved name, and whether layers disagree.
- `encodeMap(map, { sortNames? })` / `decodeMap(encoded)` — base64 VLQ codec. The names table dedups by exact string; sorting the table remaps indices so segment meaning never changes.
- `NameTable` — exact-string name interning; `sorted()` returns a `remap` of old to new indices.

## Name policy

Walking the chain from the generated side towards the original source, the
first explicit name wins: the segment's own explicit name first, then explicit
names from more original layers. A name is explicit when it is not `undefined`
(the empty string counts). Names are never borrowed from adjacent segments —
only links on the segment's own chain contribute. Unmapped segments carry no
resolved name, though any recorded name stays visible in the chain for
diagnostics.
