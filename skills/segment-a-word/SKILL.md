---
name: segment-a-word
description: Use when you need the morphemes of a single word, because guessing a boundary produces a gloss nobody can check.
metadata:
  version: 1.0.0
---

# Segment a word

## When to use this

You have a surface form and need to know where its morpheme boundaries are, or you need to
know whether the engine can read the word at all.

## Steps

1. `glosslab segment <word>` — the gloss rows, the boundary ticks, the score and every rival
   reading inside the declared margin.
2. Read `alt` lines first. If a reading appears there, the word is **ambiguous** and a human
   has to choose; do not present the top reading as the answer.
3. If the output says `no reading`, the lexicon does not cover the word. Add the morphemes to
   `corpus/demo/corpus.json` and re-run `glosslab analyze --write`. Never invent a boundary.
4. For a caller-supplied lexicon, use the tool instead:
   `glosslab run segment_token --input '{"word":"<word>","lexemes":[…]}'`.

## Reading the output

| Line               | Meaning                                        |
| ------------------ | ---------------------------------------------- |
| `person PL`        | glosses, one per morpheme, in column order     |
| `│────┤`           | one tick per morpheme boundary                 |
| `kav m`            | the forms, aligned under their glosses         |
| `score 4`          | the sum of the lexeme weights the engine chose |
| `alt kav-m (3.95)` | a rival reading within `ambiguityMargin`       |
| `[AMB]`            | at least two readings tie within the margin    |
| `[UNSEG]`          | no path through the lexicon covers the form    |

## Rules

- The tie-break order is fixed: score, then fewer morphemes, then a longer first morpheme,
  then lexeme priority, then id. A tie therefore resolves the same way every time.
- `ok: false` with a `reason` is a real answer, not a failure to work around.
- Determinism is the point: the same word and lexicon always give the same reading, so a
  difference between two runs means an input changed.

## Verify

`glosslab run segment_token --input '{"word":"kavm"}'` prints `kav` and `m` with score 4.
