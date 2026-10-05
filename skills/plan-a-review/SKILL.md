---
name: plan-a-review
description: Use when there are more disputed morphemes than linguist hours, because the scheduler returns a plan with a checked capacity certificate.
metadata:
  version: 1.0.0
---

# Plan a review

## When to use this

A corpus has produced more disputes than there is reviewer time, and someone has to decide
what gets looked at.

## Steps

1. `glosslab analyze` — read the counts: how many tokens are unsegmentable, ambiguous, or in
   feature clash. These become the review nodes.
2. `glosslab plan` — the assignments, and the certificate that says whether they fit.
3. **Read the certificate line first.** `verified — no window is oversubscribed` is the only
   state in which the plan may be promised to anyone.
4. Check `unscheduled`. Anything listed there was deferred for a reason; the plan says which
   capacity ran out.
5. Re-verify before you commit to it:
   `glosslab run verify_review_plan --input @plan.json` when you have the plan as a file, or
   hand it to another agent over MCP.

## Priority and effort

The engine's judgement is a table, not a feeling:

| Kind               | Priority | Effort | Skill      |
| ------------------ | -------- | ------ | ---------- |
| `unsegmentable`    | 100      | 25 min | morphology |
| `feature_conflict` | 90       | 15 min | morphology |
| `ambiguous`        | 60       | 8 min  | morphology |
| `gap`              | 40       | 5 min  | phonology  |

Deadlines come from the same priorities: anything at 90 or above is due on the first working
day, anything at 50 or above half way through the window, the rest have no deadline.

## The certificate

`verify_plan` is a **second implementation**, not a re-run of the scheduler. It takes only the
plan and the declared capacity and re-derives every constraint: per-reviewer daily minutes,
per-day team minutes, overlapping slots, availability, skills and deadlines. If it disagrees,
`certificate.violations` names the exact window and the exact fault.

## Rules

- An `ok: false` plan is a real answer. Report `reason` and the witness; do not retry.
- Never present an unverified plan as a schedule.
- `mode: best_effort` reports what it could not place; `all_or_nothing` refuses a partial plan.

## Verify

`glosslab plan` ends with a certificate line, and exits 1 when the certificate does not verify.
