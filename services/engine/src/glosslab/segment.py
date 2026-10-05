"""Morpheme segmentation as a K-best dynamic program.

Given a word and a *declared* lexicon, this returns the highest-scoring concatenation of
lexemes, the runners-up, and the score decomposition that produced the winner. It never
invents a boundary the lexicon does not license, and when no path covers the word it says so
rather than guessing.

Two decisions make this credible rather than decorative:

1. **Every rule is declared.** Affix stacking, prefix stacking, infixes, and whether an
   opaque residue may be admitted are all fields of the input ``Grammar``. Nothing is implicit.
2. **Ties are broken by rule, not by luck.** Candidates are ordered by score, then by fewer
   morphemes, then by a longer first morpheme, then by lexeme priority, then by id. The same
   word and lexicon always produce byte-identical output, which is what the golden test pins.

Pure: no clock, no network, no randomness, no filesystem.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Final, TypedDict

from .protocol import EngineError
from .types import (
    Alternate,
    Grammar,
    Lexeme,
    ScorePart,
    SegmentedMorpheme,
    SegmentInput,
    SegmentOutput,
)

BEAM: Final[int] = 8

AFFIX_TYPES: Final[frozenset[str]] = frozenset({"prefix", "suffix", "infix", "clitic"})

DEFAULT_GRAMMAR: Final[Grammar] = {
    "maxAffixes": 3,
    "allowPrefixStack": True,
    "allowInfix": False,
    "allowGap": False,
    "gapPenalty": 0.0,
    "ambiguityMargin": 0.25,
    "requiredFeatures": [],
    "headFinalTypes": [],
}


class _Step(TypedDict):
    """One lexeme placed at one span, with the state it produced."""

    lexeme: Lexeme
    start: int
    end: int
    affixes: int
    prefixes: int
    gaps: int


class _Candidate(TypedDict):
    score: float
    steps: list[_Step]


class _Rules(TypedDict):
    """The declared grammar, read once and validated once."""

    max_affixes: int
    allow_prefix_stack: bool
    allow_infix: bool
    allow_gap: bool
    gap_penalty: float
    margin: float
    head_final_types: list[str]


@dataclass
class _Search:
    """All mutable state of one search, so the recursion stays small."""

    word: str
    rules: _Rules
    index: dict[str, list[Lexeme]]
    states: dict[tuple[int, int, int, int], list[_Candidate]] = field(default_factory=dict)
    matched_at: set[int] = field(default_factory=set)


def _number(grammar: dict[str, object], key: str, fallback: float) -> float:
    value = grammar.get(key, fallback)
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise EngineError("BAD_SHAPE", f"{key!r} must be a number")
    return float(value)


def _rules(raw: object) -> _Rules:
    if raw is None:
        merged: dict[str, object] = dict(DEFAULT_GRAMMAR)
    elif isinstance(raw, dict):
        merged = dict(raw)
        unknown = sorted(set(raw) - set(DEFAULT_GRAMMAR))
        if unknown:
            raise EngineError(
                "BAD_SHAPE",
                f"unknown grammar key(s) {', '.join(unknown)}; declared keys: "
                + ", ".join(sorted(DEFAULT_GRAMMAR)),
            )
    else:
        raise EngineError("BAD_SHAPE", "'grammar' must be an object")

    max_affixes = merged.get("maxAffixes", 3)
    if not isinstance(max_affixes, int) or max_affixes < 0:
        raise EngineError("BAD_SHAPE", "'maxAffixes' must be a non-negative integer")
    head_final = merged.get("headFinalTypes", [])
    if not isinstance(head_final, list):
        raise EngineError("BAD_SHAPE", "'headFinalTypes' must be a list")

    return _Rules(
        max_affixes=max_affixes,
        allow_prefix_stack=bool(merged.get("allowPrefixStack", True)),
        allow_infix=bool(merged.get("allowInfix", False)),
        allow_gap=bool(merged.get("allowGap", False)),
        gap_penalty=_number(merged, "gapPenalty", 0.0),
        margin=_number(merged, "ambiguityMargin", 0.25),
        head_final_types=[str(item) for item in head_final],
    )


def _index(lexemes: list[Lexeme]) -> dict[str, list[Lexeme]]:
    """Bucket lexemes by first character, ordered so iteration order is meaningful."""
    buckets: dict[str, list[Lexeme]] = {}
    for lexeme in lexemes:
        if not isinstance(lexeme, dict):
            raise EngineError("BAD_SHAPE", "every entry of 'lexemes' must be an object")
        for field_name in ("id", "morph", "type"):
            if not isinstance(lexeme.get(field_name), str):
                raise EngineError("MISSING_FIELD", f"lexeme is missing a string {field_name!r}")
        if not lexeme["morph"]:
            raise EngineError("BAD_SHAPE", f"lexeme {lexeme['id']!r} has an empty 'morph'")
        buckets.setdefault(lexeme["morph"][0], []).append(lexeme)
    for bucket in buckets.values():
        bucket.sort(key=lambda item: (-int(item.get("priority", 0)), -len(item["morph"]), item["id"]))
    return buckets


def _order(candidate: _Candidate) -> tuple[float, int, int, int, str]:
    """A total order over candidates, so no tie is ever broken by chance."""
    steps = candidate["steps"]
    first = steps[0]["lexeme"] if steps else None
    return (
        -candidate["score"],
        len(steps),
        -len(first["morph"]) if first else 0,
        -int(first.get("priority", 0)) if first else 0,
        "".join(step["lexeme"]["id"] for step in steps),
    )


def _counts(candidate: _Candidate) -> tuple[int, int, int]:
    if not candidate["steps"]:
        return 0, 0, 0
    last = candidate["steps"][-1]
    return last["affixes"], last["prefixes"], last["gaps"]


def _push(search: _Search, state: tuple[int, int, int, int], candidate: _Candidate) -> None:
    bucket = search.states.setdefault(state, [])
    signature = [step["lexeme"]["morph"] for step in candidate["steps"]]
    for index, incumbent in enumerate(bucket):
        if [step["lexeme"]["morph"] for step in incumbent["steps"]] == signature:
            if _order(candidate) < _order(incumbent):
                bucket[index] = candidate
            return
    bucket.append(candidate)
    bucket.sort(key=_order)
    del bucket[BEAM:]


def _counters(
    lexeme_type: str, candidate: _Candidate, search: _Search, position: int, end: int
) -> tuple[int, int] | None:
    """The affix/prefix counts a lexeme would produce, or None if the grammar forbids it.

    Written as one decision per morpheme type rather than a chain of guards, because the
    grammar is the product's policy and a reader should be able to see all four cases at
    once.
    """
    rules = search.rules
    affixes, prefixes, _gaps = _counts(candidate)
    if lexeme_type not in AFFIX_TYPES:
        return affixes, prefixes
    if affixes + 1 > rules["max_affixes"]:
        return None
    if lexeme_type == "infix" and (
        not rules["allow_infix"] or position == 0 or end == len(search.word)
    ):
        return None
    stacked = lexeme_type == "prefix" and not rules["allow_prefix_stack"] and prefixes >= 1
    if stacked:
        return None
    return affixes + 1, prefixes + 1 if lexeme_type == "prefix" else prefixes


def _extend(search: _Search, position: int, candidate: _Candidate) -> None:
    """Push every lexeme that can start at ``position`` one step further right."""
    rules = search.rules
    affixes, prefixes, gaps = _counts(candidate)
    for lexeme in search.index.get(search.word[position], []):
        morph = lexeme["morph"]
        end = position + len(morph)
        if search.word[position:end] != morph:
            continue
        counts = _counters(lexeme["type"], candidate, search, position, end)
        if counts is None:
            continue
        search.matched_at.update(range(position, end))
        _push(
            search,
            (end, counts[0], counts[1], gaps),
            {
                "score": round(candidate["score"] + float(lexeme.get("weight", 0.0)), 6),
                "steps": [
                    *candidate["steps"],
                    {
                        "lexeme": lexeme,
                        "start": position,
                        "end": end,
                        "affixes": counts[0],
                        "prefixes": counts[1],
                        "gaps": gaps,
                    },
                ],
            },
        )

    if rules["allow_gap"]:
        opaque: Lexeme = {
            "id": "opaque",
            "morph": search.word[position],
            "type": "unknown",
            "gloss": "",
            "weight": rules["gap_penalty"],
            "priority": 0,
            "features": {},
        }
        _push(
            search,
            (position + 1, affixes, prefixes, gaps + 1),
            {
                "score": round(candidate["score"] + rules["gap_penalty"], 6),
                "steps": [
                    *candidate["steps"],
                    {
                        "lexeme": opaque,
                        "start": position,
                        "end": position + 1,
                        "affixes": affixes,
                        "prefixes": prefixes,
                        "gaps": gaps + 1,
                    },
                ],
            },
        )


def _finals(search: _Search) -> list[_Candidate]:
    allowed = search.rules["head_final_types"]
    results: list[_Candidate] = []
    for (at, _affixes, _prefixes, _gaps), candidates in search.states.items():
        if at != len(search.word):
            continue
        for candidate in candidates:
            steps = candidate["steps"]
            if steps and (not allowed or steps[-1]["lexeme"]["type"] in allowed):
                results.append(candidate)
    return results


def _search(search: _Search) -> list[_Candidate]:
    search.states[(0, 0, 0, 0)] = [{"score": 0.0, "steps": []}]
    length = len(search.word)
    for position in range(length):
        for (at, _a, _p, _g), candidates in list(search.states.items()):
            if at != position:
                continue
            for candidate in list(candidates):
                _extend(search, position, candidate)
    return _finals(search)


def _morphemes(steps: list[_Step]) -> list[SegmentedMorpheme]:
    return [
        SegmentedMorpheme(
            lexemeId=step["lexeme"]["id"],
            morph=step["lexeme"]["morph"],
            type=step["lexeme"]["type"],
            gloss=step["lexeme"].get("gloss", ""),
            features=step["lexeme"].get("features", {}),
            start=step["start"],
            end=step["end"],
            weight=float(step["lexeme"].get("weight", 0.0)),
            known=step["lexeme"]["type"] != "unknown",
        )
        for step in steps
    ]


def _breakdown(steps: list[_Step]) -> list[ScorePart]:
    return [
        ScorePart(
            lexemeId=step["lexeme"]["id"],
            morph=step["lexeme"]["morph"],
            type=step["lexeme"]["type"],
            weight=float(step["lexeme"].get("weight", 0.0)),
            start=step["start"],
            end=step["end"],
        )
        for step in steps
    ]


def _alternates(candidates: list[_Candidate]) -> list[Alternate]:
    return [
        Alternate(
            morphemes=[step["lexeme"]["morph"] for step in candidate["steps"]],
            score=candidate["score"],
            affixCount=_counts(candidate)[0],
            gapCount=_counts(candidate)[2],
        )
        for candidate in candidates[1:]
    ]


def _fail(word: str, reason: str, failed_at: list[int]) -> SegmentOutput:
    return SegmentOutput(
        ok=False,
        word=word,
        morphemes=[],
        score=0.0,
        scoreBreakdown=[],
        alternates=[],
        ambiguous=False,
        affixCount=0,
        gapCount=0,
        headFinal=False,
        reason=reason,
        failedAt=failed_at,
    )


def segment(payload: SegmentInput) -> SegmentOutput:
    """Segment one word against a declared lexicon and grammar."""
    if not isinstance(payload, dict):
        raise EngineError("BAD_SHAPE", "segment expects an object with 'word' and 'lexemes'")
    word = payload.get("word")
    if not isinstance(word, str):
        raise EngineError("MISSING_FIELD", "'word' must be a string")
    lexemes = payload.get("lexemes")
    if not isinstance(lexemes, list):
        raise EngineError("MISSING_FIELD", "'lexemes' must be a list")
    if not word:
        return _fail(word, "empty_word", [])
    if not lexemes:
        return _fail(word, "empty_lexicon", list(range(len(word))))

    search = _Search(word=word, rules=_rules(payload.get("grammar")), index=_index(lexemes))
    finals = _search(search)

    if not finals:
        return _fail(
            word,
            "unsegmentable",
            [index for index in range(len(word)) if index not in search.matched_at],
        )

    finals.sort(key=_order)
    best = finals[0]
    margin = search.rules["margin"]
    distinct: list[_Candidate] = []
    seen: set[tuple[str, ...]] = set()
    for candidate in finals:
        if candidate is not best and best["score"] - candidate["score"] > margin:
            break
        signature = tuple(step["lexeme"]["morph"] for step in candidate["steps"])
        if signature in seen:
            continue
        seen.add(signature)
        distinct.append(candidate)

    steps = best["steps"]
    return SegmentOutput(
        ok=True,
        word=word,
        morphemes=_morphemes(steps),
        score=round(best["score"], 6),
        scoreBreakdown=_breakdown(steps),
        alternates=_alternates(distinct),
        ambiguous=len(distinct) > 1,
        affixCount=sum(1 for step in steps if step["lexeme"]["type"] in AFFIX_TYPES),
        gapCount=sum(1 for step in steps if step["lexeme"]["type"] == "unknown"),
        headFinal=not search.rules["head_final_types"]
        or steps[-1]["lexeme"]["type"] in search.rules["head_final_types"],
        reason=None,
        failedAt=[],
    )


__all__ = ["segment", "DEFAULT_GRAMMAR"]
