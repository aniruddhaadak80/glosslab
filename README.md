<div align="center">

# Glosslab

**A morphology review harness.** Segment an under-documented language against a declared
morpheme lexicon, then schedule the disputed nodes into a proven-feasible review plan.

[CI](https://github.com/aniruddhaadak80/glosslab/actions/workflows/ci.yml) ·
[Live app](https://glosslab-morphology.vercel.app) ·
[License](https://github.com/aniruddhaadak80/glosslab/blob/main/LICENSE) ·
[Issues](https://github.com/aniruddhaadak80/glosslab/issues)

</div>

---

## What this is

A field linguist has a word list and a morpheme lexicon. Three things follow, and none of them
is answered by a chatbot:

1. **Where are the morpheme boundaries?** The lexicon licenses some readings and not others.
2. **Is the reading ambiguous?** Two readings can score the same, and then a human has to choose.
3. **What do we actually look at first?** A corpus produces more disputes than a team has hours.

Glosslab answers all three with code. The engine is a pure Python function over stdin/stdout:
no server, no port, no clock, no randomness, no model call. The same word and lexicon always
produce the same reading — and when the lexicon cannot cover a word, it says `unsegmentable`
instead of inventing a boundary.

> **The corpus in this repository is synthetic.** `corpus/demo/` describes a _constructed_
> demo language invented for testing. It is not documentation of any real language or community
> and must never be cited as such.

## Quick start

```bash
git clone https://github.com/aniruddhaadak80/glosslab.git
cd glosslab
npm install
npm run build
glosslab doctor
```

## Walkthrough

Every command below was run on this repository, and every output is real output.

### 1. Segment a word

```bash
glosslab segment tarkas
```

```text
tarkas    (cli)
  water DAT GEN
  │────│──│──
  tar   ka  s
  score 4.7
```

Three rows: the glosses, a tick per morpheme boundary, the forms. The engine chose `tar + ka + s`.

Now a word it cannot read, and one it cannot decide:

```bash
glosslab segment pranakav
```

```text
pranakav: no reading (unsegmentable)
  characters with no reading: 3, 4, 5, 6, 7
```

`pranakav` stacks two prefixes, which the declared grammar forbids. Nothing was guessed.

```bash
glosslab segment sakm
```

```text
sakm    (cli)  [AMB]
  ritual
  │─────
  sakm
  score 4
  alt  sak-m  (4)
```

`sakm` as one lexeme and `sak + m` score **exactly the same**. The tie-break is fixed — score,
then fewer morphemes, then a longer first morpheme, then lexeme priority, then id — so the
winner is `sakm` every time, and the reading it beat is reported rather than discarded.

### 2. Run the whole corpus

```bash
glosslab analyze
```

```text
  tokens         23
  segmented      21
  unsegmentable  2
  ambiguous      4
  morphemes      43
  review nodes   7
  scheduled      7
  unscheduled    0
  corpus hash    a515719cdaee0874
```

The 7 review nodes are the disputes: 2 unsegmentable forms, 4 ambiguities and 1 feature clash
(`tarkas` carries DAT and GEN at once, which the engine reports as
`incompatible at case: dat != gen`).

The corpus hash is a fingerprint of the inputs. `glosslab analyze --write` commits the artifact,
and `npm run check:analysis-artifact` fails if the committed artifact stops matching a fresh
engine run — so "the web page shows real segmentations" is a checked claim, not a hope.

### 3. Read the plan and its certificate

```bash
glosslab plan
```

```text
plan: 7 scheduled, 0 deferred
certificate: verified — no window is oversubscribed
  effort 97m of 97m across 1200m of capacity (8% used)
  peak 2026-03-02: 97m of 240m
  residual 03-02=143m 03-03=240m 03-04=240m 03-05=240m 03-06=180m

day         slot          reviewer   node                    time
2026-03-02  09:00-09:25  r-anne     t16:unsegmentable       25m
2026-03-02  09:00-09:25  r-bo       t19:unsegmentable       25m
2026-03-02  09:25-09:40  r-anne     t08:feature_conflict    15m
2026-03-02  09:25-09:33  r-bo       t09:ambiguous            8m
2026-03-02  09:33-09:41  r-bo       t12:ambiguous            8m
2026-03-02  09:40-09:48  r-anne     t17:ambiguous            8m
2026-03-02  09:41-09:49  r-bo       t20:ambiguous            8m
```

Two reviewers working in parallel, no overlapping slots, the two unsegmentable forms first
because they are due on the first working day.

The certificate is the part that matters. It is produced by `verify_plan`, a **second
implementation** that never sees the scheduler: it takes the plan and the declared capacity and
re-derives per-reviewer minutes, per-day team minutes, overlaps, availability, skills and
deadlines from scratch. A property test asserts that a plan the scheduler calls feasible is one
the verifier also calls feasible, for arbitrary input.

### 4. Browse it in the terminal

```bash
glosslab tui
```

A split pane: dense token list on the left, interlinear gloss on the right, `/` to filter,
`j`/`k` to move, `tab` to switch pane, `q` to leave. It is a pure state machine with a thin I/O
loop, so the whole interface is unit-tested by comparing strings — no TTY required.

### 5. Hand it to a tool that already exists

```bash
glosslab export corpus/demo/export
```

```text
wrote corpus/demo/export/kavrin-demo.txt (attempts 1)
```

A tab-separated `.txt` interlinear gloss — the interchange ELAN, FLEx, Leex and NexusPLAS all
read. The header carries the language, the token count and the corpus hash, so a reviewer can
tell which run produced the file.

### 6. Query without re-running the engine

```bash
glosslab project
```

```text
projected 23 tokens, 43 morphemes into .data/glosslab.sqlite
  review nodes 7, assignments 7
  corpus hash a515719cdaee0874, schema v3
```

SQLite with WAL, numbered migrations and an FTS5 index. The projection is derived state: it can
always be rebuilt from the artifact.

### 7. Let an agent use it

```bash
npm run mcp:proof
```

```text
initialize        ok — glosslab 0.1.0
tools/list        7 tools: analyze_corpus, list_plugins, list_skills, schedule_review, segment_token, unify_features, verify_review_plan
tools/call        segment_token("kavm") -> kav:person-m:PL score 4
tools/call        segment_token("xkavri") -> ok=false reason=unsegmentable failedAt=[0,1,2,3,4,5]
exit              code 0, 4 frames, 0 protocol errors
```

That is a raw JSON-RPC transcript over stdio — `initialize`, `tools/list`, and two `tools/call`s
that reach the Python engine. Register the server with any MCP client:

```json
{
  "mcpServers": {
    "glosslab": {
      "command": "glosslab",
      "args": ["mcp", "serve"]
    }
  }
}
```

### 8. Run the web app

```bash
npm run build
cd apps/web && npm run start
```

Then <http://localhost:3000> — a split-pane corpus browser with the same interlinear layout the
CLI prints, and `/plan` with the per-day load drawn against capacity. No client JavaScript is
needed for the primary flow: search is a GET form and selection is a link.

```bash
curl -s localhost:3000/api/health
```

```json
{
  "ok": true,
  "product": "glosslab",
  "version": "0.1.0",
  "language": "kavrin-demo",
  "corpusHash": "a515719cdaee0874",
  "tokens": 23,
  "reviewNodes": 7,
  "disputed": 7,
  "planVerified": true,
  "surfaces": { "shipped": 8, "omitted": 2 }
}
```

Every value is measured on the request. A deployment with no artifact returns `ok: false` and
HTTP 503 rather than pretending to be healthy.

## How it works

```
   CLI ─────────┐
   TUI ─────────┤
   Web ─────────┼──▶  ToolRegistry  ──▶  services/engine   (pure Python, stdin/stdout)
   MCP server ──┤         │            │    segment · unify · schedule_review · verify_plan
   Channels ────┘         └──▶  packages/memory  (SQLite projection, WAL, FTS5)
```

The invariants:

1. **One registry, one `Tool` interface.** A surface is a transport, never a second
   implementation. The CLI, the TUI, the web app and the MCP server all call the same seven tools.
2. **MCP tools are stateless.** No cross-call state, so two calls cannot interfere.
3. **Input is validated before the handler runs.**
4. **Permissions are declared** and a call exceeding the granted set is refused.
5. **A duplicate tool name throws**, naming both registrants.
6. **No cross-package deep imports** — `check:boundaries` fails otherwise.
7. **The engine is pure.** No clock, no network, no randomness, no filesystem.

### The footprint ladder

Where new capability goes, in order of preference:

1. Extend an existing tool
2. Add a CLI command plus a skill
3. Add a service-gated tool
4. Add a plugin
5. Add an MCP server tool
6. Add a new core tool — **last resort**

Every core tool is paid for in context on every request, forever; plugins are free. That
asymmetry is the whole reason for the ladder.

## What ships

| Surface              | Status  | What it is                                                |
| -------------------- | ------- | --------------------------------------------------------- |
| CLI                  | shipped | `glosslab`, with `doctor` as the flagship command         |
| Terminal UI          | shipped | split pane over the morpheme trees                        |
| Web app              | shipped | server-rendered Next.js, deployed to Vercel               |
| MCP server           | shipped | the seven tools over stdio                                |
| MCP client           | shipped | connects to configured servers, per-server enable/disable |
| Skills catalog       | shipped | `SKILL.md` discovery, validation, version gating          |
| Plugin registry      | shipped | manifest validation, priority conflict resolution         |
| Memory               | shipped | SQLite, WAL, numbered migrations, FTS5                    |
| Channels             | shipped | interlinear gloss export — the format ELAN and FLEx read  |
| Deterministic engine | shipped | pure Python over stdin/stdout                             |

### Deliberate omissions

**No desktop shell.** An Electron wrapper would be a second copy of the web app with no surface a
linguist would use, and it could not be honestly tested in this repository's CI.

**No model providers.** Segmentation, unification and scheduling have right answers. A model
call in any of them would only add a way to be wrong, which is the opposite of this product.

**No telemetry.** The corpus is a file in the repository and the queries are local. Shipping usage
data by default would contradict the design.

## Configuration

Layered, later wins: **defaults → `product.config.json` → environment**.

| Key                | Default       | Meaning                          |
| ------------------ | ------------- | -------------------------------- |
| `productEnv`       | `development` | runtime mode                     |
| `dataDir`          | `.data`       | where the SQLite projection goes |
| `engine.python`    | `python`      | interpreter for the engine       |
| `engine.timeoutMs` | `20000`       | hard ceiling on one engine call  |
| `logLevel`         | `info`        | log verbosity                    |

An invalid value raises a `ValidationError` naming the field — it is never coerced. See
[docs/configuration.md](docs/configuration.md).

## Documentation

| Page                                       | Read it when                              |
| ------------------------------------------ | ----------------------------------------- |
| [getting-started](docs/getting-started.md) | you have just cloned this                 |
| [architecture](docs/architecture.md)       | you need the map before changing anything |
| [cli](docs/cli.md)                         | you are scripting the CLI                 |
| [mcp](docs/mcp.md)                         | you are connecting an agent               |
| [skills](docs/skills.md)                   | you are writing or editing a skill        |
| [plugins](docs/plugins.md)                 | you are adding an extension               |
| [ci](docs/ci.md)                           | you are adding a gate                     |
| [troubleshooting](docs/troubleshooting.md) | something is broken                       |
| [adr/](docs/adr/)                          | you want the reasoning behind a decision  |

## Development

```bash
npm install
npm run build                  # turbo build across every package
npm run typecheck              # tsc --noEmit, every package
npm run lint                   # eslint
npm run format                 # prettier --write
npm test                       # vitest, every package
npm run pytest                 # the Python engine: 130 tests, property tests, golden file
npm run check:analysis-artifact # the committed artifact still matches a fresh engine run
npm run check                  # everything CI runs, in CI's order
```

Requires Node ≥ 22.12 and Python ≥ 3.11. If `better-sqlite3` has no prebuilt binary for your
platform, run `npm rebuild better-sqlite3` — `doctor` will tell you so with a fix hint.

Contributing: [CONTRIBUTING.md](CONTRIBUTING.md). The rules that are not negotiable are in
[AGENTS.md](AGENTS.md); the reasoning behind each decision is in [docs/adr/](docs/adr/).

## License

MIT — see [LICENSE](LICENSE). Third-party notices are in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). The demo corpus is synthetic and carries no
third-party data.
