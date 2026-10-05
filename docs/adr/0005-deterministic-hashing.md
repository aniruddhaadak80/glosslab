# ADR 0005 — The corpus hash must not depend on how a number was spelled

- **Status:** accepted
- **Relates to:** [0002](0002-python-engine-boundary.md), [0004](0004-ledger-and-projection.md)

## Context

This repository claims to be deterministic: "the same word and lexicon always produce the same
reading". That claim is the product.

It was false, and in the most embarrassing way possible. The corpus hash differed depending on
how the corpus reached the engine:

- Called from Python (a pytest, the golden test), `json.load` read `"weight": 3.0` as a **float**.
- Called from the CLI, the TypeScript host serialised with `JSON.stringify`, which writes `3.0`
  as `3`. Python's `json.loads` read that as an **int**.

Both were the same corpus. The hash was over a canonical JSON string, so `3.0` and `3` produced
different strings, different SHA-256 digests, and a corpus hash of `2df14c4775a4c826` from one
path and `8a7d0dd021485a9a` from the other. The artifact gate caught it — but it caught it as
"stale artifact", which is the _symptom_. The cause was a number-formatting difference that had
nothing to do with the analysis.

Any property of the product that depends on hashing or comparing engine output inherits this bug:
golden files, cache keys, drift detection, "has the corpus changed?" checks.

## Decision

**Normalise every number in the canonical form used for hashing.**

`glosslab.analysis._canonical` walks the value and renders each number through
`float(value)` at a fixed precision, so `3` and `3.0` hash identically while `0.25` and `0.26`
do not. Non-numeric leaves keep `json.dumps` escaping.

The hash still covers exactly the inputs that change an answer — `tokens`, `lexemes`,
`grammar` — and deliberately excludes reviewer capacity, which changes the plan but no
segmentation. Two tests pin both halves of that: one asserts the spelling independence, one
asserts the coverage and the exclusion.

## Consequences

- A hash is now a property of the data, not of the transport. The CLI, MCP, a pytest and a
  future adapter all agree.
- Cost: a hash collision between `3` and `3.0` _is now intended_. That is correct — they are the
  same value, and the engine treats them identically.
- The lesson generalises: any cross-language canonicalisation needs a test that runs the value
  through **both** languages. This one did not have that test, and the artifact gate found it by
  accident rather than by design.

## Follow-up rule

Any new canonical form (cache keys, artifact fingerprints, drift checks) gets a test that feeds
it a value through the Python encoder and the `JSON.stringify` encoder and asserts the digests
match. That test is the point; the canonicaliser is just the implementation.
