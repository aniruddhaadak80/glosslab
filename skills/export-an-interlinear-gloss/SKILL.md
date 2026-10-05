---
name: export-an-interlinear-gloss
description: Use when the analysis has to reach a tool that already exists elsewhere, because the txt interlinear gloss is what ELAN, FLEx and NexusPLAS read.
metadata:
  version: 1.0.0
---

# Export an interlinear gloss

## When to use this

Someone else needs the segmentations in a tool that is not Glosslab — a consultant, a
typologist, or an annotation round that happens in ELAN or FLEx.

## Steps

1. `glosslab plan --json` is not the export. Use:
   `glosslab export corpus/demo/export` — writes `kavrin-demo.txt` through the interlinear
   channel.
2. `--dry-run` prints the path without writing it. Use it first when the directory is shared.
3. Hand the file to ELAN, FLEx, Leex or NexusPLAS. The header carries the language, the token
   count and the corpus hash, so a reviewer can tell which run produced it.

## The format

Tab-separated, one row per token:

```
<form>	<gloss>	<morpheme glosses>	<morpheme types>	<score|UNSEG>
```

Lines beginning with `#` are comments. `UNSEG` in the last column means the engine found no
reading, which is information worth keeping rather than dropping the row.

## Rules

- The export is generated from the committed artifact. If the corpus changed, run
  `glosslab analyze --write` first or you will ship a stale gloss.
- The file name is the idempotency key, so re-running overwrites rather than accumulating.
  Names must be `[A-Za-z0-9._-]+`; a name with a path separator is refused on purpose.
- Retries and the outbound queue live in the channel base class. Do not reimplement them in a
  second adapter.

## Verify

`glosslab export --dry-run` prints the exact path, and `glosslab doctor` reports the channel
as ready.
