"""Unit and property tests for the segmentation dynamic program.

The properties asserted here are the ones a linguist would actually rely on:

- the morphemes always tile the word exactly, with no gaps and no overlaps;
- segmentation is a pure function of (word, lexicon, grammar);
- a wider ambiguity margin can only ever add alternates, never remove them;
- raising the affix ceiling can never make a word unsegmentable.
"""

from __future__ import annotations

import pytest
from hypothesis import assume, given, settings
from hypothesis import strategies as st

from glosslab.protocol import EngineError
from glosslab.segment import segment
from glosslab.types import Lexeme

STEM = Lexeme(
    id="kav", morph="kav", type="stem", gloss="person", weight=3.0, priority=10, features={}
)
PLURAL = Lexeme(
    id="pl", morph="m", type="suffix", gloss="PL", weight=1.0, priority=8, features={}
)
NEG = Lexeme(
    id="neg", morph="na", type="prefix", gloss="NEG", weight=0.7, priority=8, features={}
)
RITUAL = Lexeme(
    id="rit", morph="sakm", type="stem", gloss="ritual", weight=4.0, priority=5, features={}
)
SEE = Lexeme(id="see", morph="sak", type="stem", gloss="see", weight=3.0, priority=10, features={})
LUM = Lexeme(id="house", morph="lum", type="stem", gloss="house", weight=3.0, priority=10, features={})
DAT = Lexeme(id="dat", morph="ka", type="suffix", gloss="DAT", weight=0.9, priority=8, features={})
PST = Lexeme(id="pst", morph="ta", type="suffix", gloss="PST", weight=0.9, priority=8, features={})
ALSO = Lexeme(id="also", morph="ke", type="clitic", gloss="ALSO", weight=0.3, priority=7, features={})

ALL_LEXEMES = [STEM, PLURAL, NEG, RITUAL, SEE, LUM, DAT, PST, ALSO]


def test_segments_a_bare_stem() -> None:
    result = segment({"word": "kav", "lexemes": [STEM]})
    assert result["ok"] is True
    assert [part["morph"] for part in result["morphemes"]] == ["kav"]
    assert result["score"] == 3.0
    assert result["ambiguous"] is False


def test_morphemes_tile_the_word_exactly() -> None:
    result = segment({"word": "nakavm", "lexemes": [STEM, PLURAL, NEG]})
    assert result["ok"] is True
    cursor = 0
    for part in result["morphemes"]:
        assert part["start"] == cursor
        cursor = part["end"]
    assert cursor == len("nakavm")


def test_score_breakdown_sums_to_the_score() -> None:
    result = segment({"word": "nakavm", "lexemes": [STEM, PLURAL, NEG]})
    assert round(sum(part["weight"] for part in result["scoreBreakdown"]), 6) == result["score"]


def test_refuses_a_word_the_lexicon_cannot_cover() -> None:
    result = segment({"word": "kavri", "lexemes": [STEM]})
    assert result["ok"] is False
    assert result["reason"] == "unsegmentable"
    assert result["morphemes"] == []
    assert 3 in result["failedAt"]


def test_a_narrower_lexicon_can_only_hurt() -> None:
    wide = segment({"word": "nakavm", "lexemes": [STEM, PLURAL, NEG]})
    narrow = segment({"word": "nakavm", "lexemes": [STEM]})
    assert wide["ok"] is True
    assert narrow["ok"] is False


def test_an_exact_tie_breaks_towards_fewer_morphemes_and_is_reported() -> None:
    result = segment({"word": "sakm", "lexemes": [SEE, PLURAL, RITUAL]})
    assert result["ok"] is True
    assert [part["morph"] for part in result["morphemes"]] == ["sakm"]
    assert result["ambiguous"] is True
    assert result["alternates"][0]["morphemes"] == ["sak", "m"]


def test_the_margin_decides_what_counts_as_ambiguous() -> None:
    # A stem that almost, but not quite, ties with the two-morpheme reading.
    near = Lexeme(id="near", morph="sakm", type="stem", gloss="ritual", weight=3.95,
                  priority=5, features={})
    lexemes = [SEE, PLURAL, near]
    wide = segment(
        {"word": "sakm", "lexemes": lexemes, "grammar": {"ambiguityMargin": 0.25}}
    )
    narrow = segment(
        {"word": "sakm", "lexemes": lexemes, "grammar": {"ambiguityMargin": 0.0}}
    )
    assert [part["morph"] for part in wide["morphemes"]] == ["sak", "m"]
    assert wide["alternates"][0]["morphemes"] == ["sakm"]
    assert wide["ambiguous"] is True
    assert narrow["ambiguous"] is False
    assert narrow["score"] == wide["score"]


def test_max_affixes_is_enforced_by_the_declared_grammar() -> None:
    payload = {"word": "kavmm", "lexemes": [STEM, PLURAL], "grammar": {"maxAffixes": 1}}
    assert segment(payload)["ok"] is False
    payload["grammar"] = {"maxAffixes": 2}
    assert segment(payload)["ok"] is True


def test_prefix_stacking_can_be_declared_off() -> None:
    lexemes = [STEM, NEG, Lexeme(id="neg2", morph="pra", type="prefix", gloss="PFV",
                                weight=0.7, priority=8, features={})]
    payload = {"word": "pranakav", "lexemes": lexemes, "grammar": {"allowPrefixStack": False}}
    assert segment(payload)["ok"] is False
    payload["grammar"] = {"allowPrefixStack": True}
    assert segment(payload)["ok"] is True


def test_infixes_are_rejected_unless_declared() -> None:
    infix = Lexeme(id="inf", morph="a", type="infix", gloss="INF", weight=0.5,
                   priority=1, features={})
    lexemes = [Lexeme(id="tk", morph="t", type="stem", gloss="t", weight=1.0,
                      priority=10, features={}),
               Lexeme(id="k", morph="k", type="stem", gloss="k", weight=1.0,
                      priority=10, features={}),
               infix]
    assert segment({"word": "tak", "lexemes": lexemes})["ok"] is False
    allowed = segment({"word": "tak", "lexemes": lexemes, "grammar": {"allowInfix": True}})
    assert allowed["ok"] is True
    assert [part["type"] for part in allowed["morphemes"]] == ["stem", "infix", "stem"]


def test_an_infix_may_not_touch_either_edge() -> None:
    infix = Lexeme(id="inf", morph="a", type="infix", gloss="INF", weight=0.5,
                   priority=1, features={})
    lexemes = [
        Lexeme(id="t", morph="t", type="stem", gloss="t", weight=1.0,
               priority=10, features={}),
        Lexeme(id="ka", morph="ka", type="stem", gloss="ka", weight=1.0,
               priority=10, features={}),
        infix,
    ]
    # t + a + ka: the infix is interior, so this is the one legal reading.
    interior = segment({"word": "taka", "lexemes": lexemes, "grammar": {"allowInfix": True}})
    assert interior["ok"] is True
    assert [part["start"] for part in interior["morphemes"]] == [0, 1, 2]
    assert [part["type"] for part in interior["morphemes"]] == ["stem", "infix", "stem"]

    # ata would need the infix at position 0, which the grammar forbids.
    edge = segment({"word": "ata", "lexemes": lexemes, "grammar": {"allowInfix": True}})
    assert edge["ok"] is False


def test_head_final_types_are_honoured() -> None:
    # The final morpheme here is a stem, so a suffix-final grammar must reject the word.
    payload = {
        "word": "nakav",
        "lexemes": [STEM, NEG],
        "grammar": {"headFinalTypes": ["suffix"]},
    }
    assert segment(payload)["ok"] is False
    payload["grammar"] = {"headFinalTypes": ["stem", "suffix"]}
    assert segment(payload)["ok"] is True


def test_gaps_are_opt_in_and_are_marked_unknown() -> None:
    payload = {
        "word": "kavq",
        "lexemes": [STEM],
        "grammar": {"allowGap": True, "gapPenalty": -1.0},
    }
    result = segment(payload)
    assert result["ok"] is True
    assert result["gapCount"] == 1
    assert result["morphemes"][-1]["type"] == "unknown"
    assert result["morphemes"][-1]["known"] is False


def test_empty_inputs_are_reported_not_crashed() -> None:
    assert segment({"word": "", "lexemes": [STEM]})["reason"] == "empty_word"
    assert segment({"word": "kav", "lexemes": []})["reason"] == "empty_lexicon"


@pytest.mark.parametrize(
    "payload",
    [
        {"lexemes": [STEM]},
        {"word": 7, "lexemes": [STEM]},
        {"word": "kav", "lexemes": "nope"},
        {"word": "kav", "lexemes": [{"id": "x"}]},
        {"word": "kav", "lexemes": [{"id": "x", "morph": "", "type": "stem"}]},
        {"word": "kav", "lexemes": [STEM], "grammar": []},
        {"word": "kav", "lexemes": [STEM], "grammar": {"nonsense": 1}},
        {"word": "kav", "lexemes": [STEM], "grammar": {"maxAffixes": -1}},
        {"word": "kav", "lexemes": [STEM], "grammar": {"ambiguityMargin": "wide"}},
    ],
)
def test_rejects_malformed_input(payload: object) -> None:
    with pytest.raises(EngineError):
        segment(payload)  # type: ignore[arg-type]


# ------------------------------------------------------------------ property tests


morphs = st.sampled_from(["kav", "lum", "m", "ka", "ta", "na", "sak", "sakm", "ke"])
words = st.lists(morphs, min_size=1, max_size=4).map("".join)
# At least one affix slot, because a word made only of affixes needs one to be legal.
ceiling = st.integers(min_value=1, max_value=4)
margin = st.floats(min_value=0.0, max_value=4.0, allow_nan=False)


@settings(max_examples=150, deadline=None)
@given(word=words)
def test_morphemes_always_tile_the_word(word: str) -> None:
    result = segment({"word": word, "lexemes": ALL_LEXEMES, "grammar": {"maxAffixes": 4}})
    assert result["ok"] is True, f"{word!r} should be segmentable from these morphemes"
    cursor = 0
    for part in result["morphemes"]:
        assert part["start"] == cursor
        assert word[part["start"] : part["end"]] == part["morph"]
        cursor = part["end"]
    assert cursor == len(word)


@settings(max_examples=150, deadline=None)
@given(word=words, ceiling=ceiling)
def test_a_higher_affix_ceiling_never_hurts(word: str, ceiling: int) -> None:
    lexemes = ALL_LEXEMES
    low = segment({"word": word, "lexemes": lexemes, "grammar": {"maxAffixes": 1}})
    high = segment({"word": word, "lexemes": lexemes, "grammar": {"maxAffixes": ceiling}})
    if low["ok"]:
        assert high["ok"] is True


@settings(max_examples=100, deadline=None)
@given(word=words, margin=margin)
def test_a_wider_margin_only_adds_alternates(word: str, margin: float) -> None:
    lexemes = ALL_LEXEMES
    narrow = segment({"word": word, "lexemes": lexemes, "grammar": {"ambiguityMargin": 0.0}})
    wide = segment({"word": word, "lexemes": lexemes, "grammar": {"ambiguityMargin": margin}})
    assert len(wide["alternates"]) >= len(narrow["alternates"])
    assume(wide["ok"] and narrow["ok"])
    assert wide["score"] == narrow["score"]


@settings(max_examples=100, deadline=None)
@given(word=words)
def test_segmentation_is_deterministic(word: str) -> None:
    payload = {"word": word, "lexemes": ALL_LEXEMES}
    assert segment(payload) == segment(payload)


@settings(max_examples=100, deadline=None)
@given(word=words)
def test_the_winner_never_scores_below_an_alternate(word: str) -> None:
    result = segment({"word": word, "lexemes": ALL_LEXEMES})
    for alternate in result["alternates"]:
        assert alternate["score"] <= result["score"]
