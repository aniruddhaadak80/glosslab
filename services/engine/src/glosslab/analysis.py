"""The operation registry: the engine's public surface.

One JSON object in on stdin, one named operation out. Four operations, and the fourth is
the one that matters:

- ``segment``        one word against a declared lexicon.
- ``unify``          do two feature structures agree?
- ``schedule_review``assign the resulting disputes to reviewers, with a certificate.
- ``analyze_corpus`` all of the above over a token list, producing the artifact the web app,
  the TUI and the interlinear export all read. It is pure composition — no clock, no
  filesystem, no network — so the artifact committed to the repository can be regenerated
  and byte-compared on any machine.
"""

from __future__ import annotations

import hashlib
import json
from typing import Any, Final, TypedDict

from .features import UnifyInput, unify
from .protocol import EngineError
from .schedule import schedule_review, verify_plan
from .segment import segment
from .types import (
    CorpusInput,
    CorpusOutput,
    CorpusToken,
    FeatureStructure,
    ReviewNode,
    SegmentedMorpheme,
    Token,
)

# Effort and priority per kind of dispute. These are the product's judgement about what costs
# a linguist's time, and they live in one table so they can be argued with in one place.
EFFORT: Final[dict[str, tuple[int, int]]] = {
    # kind -> (priority, effortMinutes)
    "unsegmentable": (100, 25),
    "feature_conflict": (90, 15),
    "ambiguous": (60, 8),
    "gap": (40, 5),
    "manual": (20, 10),
}

SKILL: Final[dict[str, str]] = {
    "unsegmentable": "morphology",
    "feature_conflict": "morphology",
    "ambiguous": "morphology",
    "gap": "phonology",
    "manual": "any",
}

# Deadline policy thresholds, read off the priority in EFFORT. Anything urgent is due on the
# first working day; anything merely ambiguous is due halfway through the window.
URGENT_PRIORITY: Final[int] = 90
MEDIUM_PRIORITY: Final[int] = 50


def _canonical(value: object) -> str:
    """Canonical JSON with numbers normalised.

    A plain ``json.dumps(sort_keys=True)`` is not enough here, and the reason is worth stating
    because it is a real trap: the TypeScript host serialises with ``JSON.stringify``, which
    writes ``3.0`` as ``3``. Python then reads the int, so the same corpus hashes differently
    depending on whether it arrived from the CLI or from a local test. Normalising every number
    through ``float()`` at a fixed precision makes the hash depend on the *value* and not on how
    the JSON happened to be spelled.
    """
    if value is None or isinstance(value, bool):
        return json.dumps(value)
    if isinstance(value, (int, float)):
        return f"{float(value):.6f}"
    if isinstance(value, str):
        return json.dumps(value)
    if isinstance(value, (list, tuple)):
        return "[" + ",".join(_canonical(item) for item in value) + "]"
    if isinstance(value, dict):
        body = ",".join(
            f"{json.dumps(str(key))}:{_canonical(value[key])}" for key in sorted(value, key=str)
        )
        return "{" + body + "}"
    return json.dumps(str(value))


def _hash(value: object) -> str:
    return hashlib.sha256(_canonical(value).encode("utf-8")).hexdigest()[:16]


def _tokens(payload: object) -> list[Token]:
    if not isinstance(payload, list):
        raise EngineError("BAD_SHAPE", "'tokens' must be a list")
    result: list[Token] = []
    for index, raw in enumerate(payload):
        if not isinstance(raw, dict):
            raise EngineError("BAD_SHAPE", f"tokens[{index}] must be an object")
        form = raw.get("form")
        if not isinstance(form, str) or not form:
            raise EngineError("BAD_SHAPE", f"tokens[{index}] needs a non-empty string 'form'")
        result.append(
            {
                "id": str(raw.get("id", f"t{index + 1}")),
                "form": form,
                "gloss": str(raw.get("gloss", "")),
                "provenance": str(raw.get("provenance", "")),
            }
        )
    return result


def _feature_issue(morphemes: list[SegmentedMorpheme], required: list[str]) -> str | None:
    """Return a human reason when a word's own morphological features cannot agree.

    Two case markers on one word, or a word the grammar says must carry a number that it
    does not, are exactly the failures worth catching before a linguist spends an afternoon
    on them. Both are real agreement failures, so both are reported here rather than being
    smoothed over by a model.
    """
    merged: FeatureStructure = {}
    for morpheme in morphemes:
        if morpheme["type"] == "stem" or not morpheme["features"]:
            continue
        result = unify(
            UnifyInput(left=merged, right=morpheme["features"], dictionary={}, required=[])
        )
        if not result["ok"]:
            conflict = result["conflicts"][0] if result["conflicts"] else None
            if conflict is not None:
                return (
                    f"incompatible at {conflict['path']}: "
                    f"{conflict['left']} != {conflict['right']}"
                )
            return f"{result['reason']} while merging {morpheme['morph']}"
        merged = result["merged"]
    if required:
        probe = unify(
            UnifyInput(left=merged, right={}, dictionary={}, required=list(required))
        )
        if not probe["ok"]:
            return f"missing required feature(s): {', '.join(sorted(required))}"
    return None


def _deadline_for(priority: int, days: list[str]) -> str | None:
    """The default deadline policy, derived from the team's working days."""
    if not days:
        return None
    if priority >= URGENT_PRIORITY:
        return days[0]
    if priority >= MEDIUM_PRIORITY:
        return days[len(days) // 2]
    return None


def analyze_corpus(payload: CorpusInput) -> CorpusOutput:
    """Segment every token, derive the disputes, and schedule the reviews."""
    if not isinstance(payload, dict):
        raise EngineError("BAD_SHAPE", "analyze_corpus expects an object")
    tokens = _tokens(payload.get("tokens"))
    lexemes = payload.get("lexemes")
    if not isinstance(lexemes, list):
        raise EngineError("MISSING_FIELD", "'lexemes' must be a list")
    grammar = payload.get("grammar") or {}
    dictionary = payload.get("dictionary") or {}
    reviewers = payload.get("reviewers") or []
    capacity = payload.get("capacity") or {}
    required = list(grammar.get("requiredFeatures") or [])

    analysed: list[CorpusToken] = []
    review_nodes: list[ReviewNode] = []
    days = sorted(capacity) if isinstance(capacity, dict) else []

    for token in tokens:
        result = segment(
            {
                "word": token["form"],
                "lexemes": lexemes,
                "grammar": grammar,
                "dictionary": dictionary,
            }
        )
        kinds: list[tuple[str, str]] = []
        issue: str | None = None
        if not result["ok"]:
            kinds.append(("unsegmentable", "no path through the lexicon covers this form"))
        else:
            if result["ambiguous"]:
                kinds.append(("ambiguous", "another reading scores within the declared margin"))
            if result["gapCount"] > 0:
                kinds.append(("gap", "part of the form is not in the lexicon"))
            issue = _feature_issue(result["morphemes"], required)
            if issue:
                kinds.append(("feature_conflict", issue))
        analysed.append(
            CorpusToken(
                id=token["id"],
                form=token["form"],
                gloss=token["gloss"],
                provenance=token["provenance"],
                ok=result["ok"],
                reason=result["reason"],
                featureIssue=issue,
                score=result["score"],
                ambiguous=result["ambiguous"],
                gapCount=result["gapCount"],
                morphemes=result["morphemes"],
                alternates=result["alternates"],
            )
        )
        for kind, detail in kinds:
            priority, effort = EFFORT[kind]
            review_nodes.append(
                ReviewNode(
                    id=f"{token['id']}:{kind}",
                    token=token["form"],
                    kind=kind,
                    detail=detail,
                    priority=priority,
                    effortMinutes=effort,
                    deadline=_deadline_for(priority, days),
                    requiredSkill=SKILL[kind],
                )
            )

    plan = schedule_review(
        {
            "nodes": review_nodes,
            "reviewers": reviewers,
            "capacity": capacity,
            "dayStartMinute": payload.get("dayStartMinute", 9 * 60),
            "dayEndMinute": payload.get("dayEndMinute", 17 * 60),
            "mode": "best_effort",
        }
    )

    stats: dict[str, int | float] = {
        "tokens": len(tokens),
        "segmented": sum(1 for item in analysed if item["ok"]),
        "unsegmentable": sum(1 for item in analysed if not item["ok"]),
        "ambiguous": sum(1 for item in analysed if item["ambiguous"]),
        "withGap": sum(1 for item in analysed if item["gapCount"] > 0),
        "reviewNodes": len(review_nodes),
        "scheduled": len(plan["assignments"]),
        "unscheduled": len(plan["unscheduled"]),
        "morphemes": sum(len(item["morphemes"]) for item in analysed),
    }

    return CorpusOutput(
        ok=True,
        language=str(payload.get("language", "")),
        corpusHash=_hash({"tokens": tokens, "lexemes": lexemes, "grammar": grammar}),
        tokens=analysed,
        reviewNodes=review_nodes,
        plan=plan,
        stats=stats,
    )


class _Operation(TypedDict):
    name: str
    summary: str


OPERATIONS: Final[dict[str, Any]] = {
    "segment": segment,
    "unify": unify,
    "schedule_review": schedule_review,
    "verify_plan": verify_plan,
    "analyze_corpus": analyze_corpus,
}

DESCRIPTIONS: Final[tuple[_Operation, ...]] = (
    {"name": "segment", "summary": "Segment one word against a declared morpheme lexicon."},
    {"name": "unify", "summary": "Unify two feature structures and report typed failures."},
    {
        "name": "schedule_review",
        "summary": "Assign review nodes to reviewer capacity and emit a feasibility certificate.",
    },
    {
        "name": "verify_plan",
        "summary": "Independently re-check a plan against capacity, skills and deadlines.",
    },
    {
        "name": "analyze_corpus",
        "summary": "Segment a whole corpus, derive review nodes, and schedule the reviews.",
    },
)


def analyse(op: str, payload: Any) -> Any:
    """Route one operation to its handler. This is the engine's only entry point."""
    handler = OPERATIONS.get(op)
    if handler is None:
        known = ", ".join(sorted(OPERATIONS))
        raise EngineError("UNKNOWN_OP", f"unknown op {op!r}; available: {known}")
    return handler(payload)
