"""Corpus-level tests: the operation registry, the demo corpus, and the golden file.

The golden test is the anti-drift one. If a change to the dynamic program, the tie-breaks or
the deadline policy alters a single segmentation, this fails and someone has to look at it
on purpose.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from glosslab.analysis import OPERATIONS, _hash, analyze_corpus, analyse
from glosslab.protocol import EngineError
from glosslab.types import CorpusInput

CORPUS_PATH = Path(__file__).resolve().parents[3] / "corpus" / "demo" / "corpus.json"
GOLDEN_PATH = Path(__file__).parent / "golden" / "demo_corpus.json"


def load_corpus() -> CorpusInput:
    return json.loads(CORPUS_PATH.read_text(encoding="utf-8"))  # type: ignore[no-any-return]


def test_the_registry_exposes_exactly_the_five_product_operations() -> None:
    assert sorted(OPERATIONS) == [
        "analyze_corpus",
        "schedule_review",
        "segment",
        "unify",
        "verify_plan",
    ]


def test_an_unknown_operation_lists_the_real_ones() -> None:
    with pytest.raises(EngineError) as error:
        analyse("nope", {})
    assert "analyze_corpus" in str(error.value)


def test_the_demo_corpus_is_marked_synthetic() -> None:
    corpus = load_corpus()
    assert corpus["language"] == "kavrin-demo"
    assert "constructed demo language" in corpus["label"]
    assert "invented for testing" in corpus["notice"]


def test_the_demo_corpus_segments_as_documented() -> None:
    result = analyze_corpus(load_corpus())
    stats = result["stats"]
    assert stats["tokens"] == 23
    assert stats["segmented"] == 21
    assert stats["unsegmentable"] == 2
    assert stats["ambiguous"] == 4
    assert stats["reviewNodes"] == 7


def test_the_unsegmentable_tokens_are_the_two_the_grammar_rejects() -> None:
    result = analyze_corpus(load_corpus())
    forms = {token["form"] for token in result["tokens"] if not token["ok"]}
    # xkavri contains a sound the lexicon has never seen; pranakav stacks two prefixes,
    # which the declared grammar forbids.
    assert forms == {"xkavri", "pranakav"}


def test_an_ambiguous_token_reports_the_reading_it_beat() -> None:
    result = analyze_corpus(load_corpus())
    sakm = next(token for token in result["tokens"] if token["form"] == "sakm")
    assert sakm["ambiguous"] is True
    assert [part["morph"] for part in sakm["morphemes"]] == ["sakm"]
    assert sakm["alternates"][0]["morphemes"] == ["sak", "m"]


def test_a_feature_clash_is_reported_with_both_values() -> None:
    result = analyze_corpus(load_corpus())
    tarkas = next(token for token in result["tokens"] if token["form"] == "tarkas")
    assert tarkas["featureIssue"] == "incompatible at case: dat != gen"


def test_every_review_node_is_scheduled_and_the_certificate_holds() -> None:
    result = analyze_corpus(load_corpus())
    plan = result["plan"]
    assert plan["ok"] is True
    assert plan["unscheduled"] == []
    assert len(plan["assignments"]) == len(result["reviewNodes"])
    assert plan["certificate"]["verified"] is True
    assert plan["certificate"]["violations"] == []


def test_review_nodes_carry_the_reason_a_human_needs() -> None:
    result = analyze_corpus(load_corpus())
    kinds = {node["kind"] for node in result["reviewNodes"]}
    assert kinds == {"unsegmentable", "ambiguous", "feature_conflict"}
    for node in result["reviewNodes"]:
        assert node["detail"], f"{node['id']} must say why it needs review"
        assert node["requiredSkill"] in {"morphology", "phonology", "any"}


def test_the_same_corpus_always_produces_the_same_hash() -> None:
    assert analyze_corpus(load_corpus())["corpusHash"] == analyze_corpus(load_corpus())["corpusHash"]


def test_a_different_lexicon_produces_a_different_hash() -> None:
    corpus: dict[str, Any] = dict(load_corpus())
    other = analyze_corpus(corpus)
    corpus["lexemes"] = list(corpus["lexemes"])[:2]
    assert analyze_corpus(corpus)["corpusHash"] != other["corpusHash"]


def test_the_corpus_hash_ignores_how_a_number_was_spelled() -> None:
    # The TypeScript host serialises with JSON.stringify, which writes 3.0 as 3. If the hash
    # were taken over the raw JSON text it would change with the transport, and "deterministic"
    # would only be true when called from Python.
    assert _hash({"weight": 3.0}) == _hash({"weight": 3})
    assert _hash({"effort": 30.0}) == _hash({"effort": 30})
    assert _hash({"margin": 0.25}) != _hash({"margin": 0.26})


def test_the_corpus_hash_covers_the_inputs_that_change_the_answer() -> None:
    base = load_corpus()
    original = analyze_corpus(base)["corpusHash"]

    other_lexicon: dict[str, Any] = dict(base)
    other_lexicon["lexemes"] = list(base["lexemes"])[:2]
    assert analyze_corpus(other_lexicon)["corpusHash"] != original

    other_grammar: dict[str, Any] = dict(base)
    other_grammar["grammar"] = {**base["grammar"], "ambiguityMargin": 0.9}
    assert analyze_corpus(other_grammar)["corpusHash"] != original

    # Reviewer capacity does not change any segmentation, so it must not move the hash.
    other_capacity: dict[str, Any] = dict(base)
    other_capacity["capacity"] = {**base["capacity"], "2026-03-02": 10}
    assert analyze_corpus(other_capacity)["corpusHash"] == original


def test_the_golden_file_matches_the_engine_today() -> None:
    result = analyze_corpus(load_corpus())
    golden = json.loads(GOLDEN_PATH.read_text(encoding="utf-8"))
    assert result == golden, (
        "the committed corpus artifact is stale — regenerate it and review the diff"
    )


@pytest.mark.parametrize(
    "payload",
    [
        {"lexemes": []},
        {"tokens": "nope", "lexemes": []},
        {"tokens": [{"form": ""}], "lexemes": []},
        {"tokens": [{"form": "kav"}], "lexemes": "nope"},
    ],
)
def test_rejects_malformed_corpus_input(payload: object) -> None:
    with pytest.raises(EngineError):
        analyze_corpus(payload)  # type: ignore[arg-type]


def test_an_empty_corpus_produces_an_empty_but_valid_artifact() -> None:
    result = analyze_corpus({"tokens": [], "lexemes": [], "grammar": {}})
    assert result["tokens"] == []
    assert result["reviewNodes"] == []
    assert result["stats"]["tokens"] == 0
    assert result["plan"]["certificate"]["verified"] is True
