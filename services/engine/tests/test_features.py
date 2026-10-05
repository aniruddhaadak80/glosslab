"""Unit tests for feature-structure unification.

The failure taxonomy is the contract, so every failure kind is asserted separately.
"""

from __future__ import annotations

import pytest

from glosslab.features import is_reference, is_structure, render, unify
from glosslab.protocol import EngineError


def test_agrees_and_merges() -> None:
    result = unify({"left": {"a": 1}, "right": {"b": 2}})
    assert result["ok"] is True
    assert result["reason"] is None
    assert result["merged"] == {"a": 1, "b": 2}


def test_reports_a_conflict_with_its_path() -> None:
    result = unify({"left": {"number": "sg"}, "right": {"number": "pl"}})
    assert result["ok"] is False
    assert result["reason"] == "incompatible"
    assert result["conflicts"] == [{"path": "number", "left": "sg", "right": "pl"}]


def test_reports_features_only_one_side_had() -> None:
    result = unify({"left": {"case": "dat"}, "right": {"number": "pl"}})
    assert result["ok"] is True
    assert result["unspecified"] == [
        {"path": "case", "side": "right"},
        {"path": "number", "side": "left"},
    ]


def test_missing_is_a_distinct_failure_from_incompatible() -> None:
    result = unify({"left": {"case": "dat"}, "right": {"case": "dat"}, "required": ["number"]})
    assert result["ok"] is False
    assert result["reason"] == "missing"


def test_nested_structures_unify_recursively() -> None:
    result = unify(
        {
            "left": {"agreement": {"person": 3}},
            "right": {"agreement": {"number": "pl"}},
        }
    )
    assert result["merged"] == {"agreement": {"person": 3, "number": "pl"}}


def test_conflict_inside_a_nested_structure_keeps_its_dotted_path() -> None:
    result = unify(
        {
            "left": {"agreement": {"number": "sg"}},
            "right": {"agreement": {"number": "pl"}},
        }
    )
    assert result["reason"] == "incompatible"
    assert result["conflicts"][0]["path"] == "agreement.number"


def test_resolves_a_reference_through_the_dictionary() -> None:
    result = unify(
        {
            "left": {"number": {"@ref": "suf-pl:number"}},
            "right": {"number": "pl"},
            "dictionary": {"suf-pl": {"number": "pl"}},
        }
    )
    assert result["ok"] is True
    assert result["merged"] == {"number": "pl"}


def test_a_dangling_reference_is_its_own_failure() -> None:
    result = unify(
        {
            "left": {"number": {"@ref": "suf-pl:number"}},
            "right": {"number": "pl"},
            "dictionary": {},
        }
    )
    assert result["ok"] is False
    assert result["reason"] == "deref_fail"
    assert result["unresolvedRefs"] == ["suf-pl:number"]


def test_a_reference_to_a_missing_feature_is_also_dangling() -> None:
    result = unify(
        {
            "left": {"x": {"@ref": "a:absent"}},
            "right": {"x": 1},
            "dictionary": {"a": {"present": 2}},
        }
    )
    assert result["reason"] == "deref_fail"


def test_deref_failure_outranks_a_conflict() -> None:
    result = unify(
        {
            "left": {"a": {"@ref": "nope:x"}, "b": 1},
            "right": {"b": 2},
        }
    )
    assert result["reason"] == "deref_fail"


@pytest.mark.parametrize(
    "payload",
    [
        {"right": {}},
        {"left": "not-a-structure"},
        {"left": {}, "right": {}, "dictionary": []},
        {"left": {}, "right": {}, "required": "number"},
        {"left": {}, "right": {}, "required": [7]},
    ],
)
def test_rejects_malformed_input(payload: object) -> None:
    with pytest.raises(EngineError):
        unify(payload)  # type: ignore[arg-type]


def test_empty_structures_unify() -> None:
    result = unify({"left": {}, "right": {}})
    assert result["ok"] is True
    assert result["merged"] == {}


def test_deeply_nested_input_is_rejected_rather_than_recursing_forever() -> None:
    deep: dict[str, object] = {"a": 1}
    for _ in range(80):
        deep = {"n": deep}
    with pytest.raises(EngineError):
        unify({"left": deep, "right": deep})


def test_type_predicates() -> None:
    assert is_structure({"a": 1}) is True
    assert is_structure(3) is False
    assert is_reference({"@ref": "a:b"}) is True
    assert is_reference({"@ref": "a:b", "extra": 1}) is False
    assert is_structure({"@ref": "a:b"}) is False


def test_render_is_human_readable() -> None:
    assert render("sg") == "sg"
    assert render(True) == "true"
    assert render(4) == "4"
    assert render({"@ref": "a:b"}) == "@a:b"
    assert render({"b": 2, "a": "x"}) == "{a=x, b=2}"


def test_output_is_stable_regardless_of_key_order() -> None:
    first = unify({"left": {"a": 1, "b": 2}, "right": {"b": 2, "a": 1}})
    second = unify({"left": {"b": 2, "a": 1}, "right": {"a": 1, "b": 2}})
    assert first == second
