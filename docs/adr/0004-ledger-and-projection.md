# ADR 0004 — The ledger is an append-only log; SQLite is a projection

- **Status:** accepted
- **Supersedes:** nothing
- **Relates to:** [0002](0002-python-engine-boundary.md)

## Context

The novelty engine drew `postgres` as this product's storage coordinate. That was the plan, and
the plan turned out to be wrong for this repository, for three reasons that all came from the
non-negotiables rather than from taste:

1. **No secrets, ever.** A deployed Postgres needs a connection string. Committing one is
   forbidden; injecting one means this build could not be verified end to end by the person
   running it, because the run would stop and ask for a credential.
2. **The web app is deployed on its own.** Vercel deploys `apps/web`; there is no database in
   that runtime, so a Postgres-backed deployment could not serve the product page at all.
3. **The data is a file.** A documentation project's corpus and its morpheme lexicon are files
   that belong in version control — that is how they are reviewed, and how a segmentation
   analysis gets proposed and argued over.

## Decision

**The append-only JSONL log is the source of truth. Everything else is derived.**

- `corpus/demo/corpus.json` — the lexicon, the grammar, the tokens and the reviewer roster. The
  only hand-written input.
- `corpus/demo/analysis.json` — the committed artifact the engine produced, carrying the corpus
  hash of the inputs that produced it.
- `apps/web/data/analysis.json` — the same artifact, copied inside the app so the deployment is
  self-contained. `check:analysis-artifact` compares the two by content and by hash, and re-runs
  the engine, so the copies cannot drift apart silently.
- `packages/memory` — a SQLite **projection** of an artifact: `tokens`, `morphemes`,
  `alternates`, `review_nodes`, `assignments`, plus an FTS5 index. Replaceable at any time by
  re-running `glosslab project`. `replace()` clears and rewrites inside one transaction,
  because a half-applied projection is worse than none: it would answer queries confidently with
  data that no longer matches the corpus.
- `.data/glosslab.sqlite` is derived and git-ignored.

## Consequences

**Good**

- The repository is the database. A clone plus Python is a complete working install.
- Every analysis is reviewable: the artifact is a diff.
- Staleness is _detectable_, not merely suspected — the hash is checked by a gate and by a
  property test.
- The deployed page provably shows engine output, because the file it reads was written by the
  engine and its hash is checked in CI.

**Bad, and accepted**

- No multi-writer concurrency. Two linguists cannot edit one corpus through this product. They
  edit files and open a pull request, which is the workflow they already have.
- The artifact is committed, so it is a merge conflict surface. It is one generated file with
  stable key order, and the gate tells you immediately when it is stale.

## What would change our mind

A deployment that needs corpus state per user — per-tenant corpora, annotations made in the web
app and read back into a plan — would need a server with a real database. The seam already
exists: `packages/engine-client`'s `loadCorpusFile`/`readArtifact` is the only place the
repository is read, so a Postgres adapter would replace those two functions and the rest of the
product would not know.
