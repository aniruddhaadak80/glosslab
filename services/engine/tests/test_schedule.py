"""Tests for the scheduler and — more importantly — for its independent verifier.

The property that carries the product's claim is this one: a plan the scheduler calls
feasible is a plan :func:`verify_plan` also calls feasible, for arbitrary input. If the
scheduler had a bug that oversold a window, the property test would find it.
"""

from __future__ import annotations

import pytest
from hypothesis import given, settings
from hypothesis import strategies as st

from glosslab.protocol import EngineError
from glosslab.schedule import schedule_review, verify_plan
from glosslab.types import ReviewNode, Reviewer

DAYS = ["2026-03-02", "2026-03-03", "2026-03-04"]
CAPACITY = {"2026-03-02": 180, "2026-03-03": 180, "2026-03-04": 120}


def node(
    node_id: str,
    effort: int = 30,
    priority: int = 10,
    skill: str | None = "morphology",
    deadline: str | None = None,
) -> ReviewNode:
    return ReviewNode(
        id=node_id,
        token=node_id,
        kind="manual",
        detail="",
        priority=priority,
        effortMinutes=effort,
        deadline=deadline,
        requiredSkill=skill,
    )


def reviewer(
    reviewer_id: str = "r1",
    skills: list[str] | None = None,
    capacity: int = 120,
    days: list[str] | None = None,
) -> Reviewer:
    return Reviewer(
        id=reviewer_id,
        skills=skills if skills is not None else ["morphology", "phonology"],
        capacityMinutesPerDay=capacity,
        availableDays=days if days is not None else list(DAYS),
    )


def schedule(**overrides: object) -> object:
    payload: dict[str, object] = {
        "nodes": [node("n1"), node("n2")],
        "reviewers": [reviewer()],
        "capacity": CAPACITY,
        "dayStartMinute": 540,
        "dayEndMinute": 1020,
    }
    payload.update(overrides)
    return schedule_review(payload)  # type: ignore[arg-type]


def verify(plan: dict[str, object], nodes: list[ReviewNode], people: list[Reviewer]) -> dict:
    return verify_plan(
        {
            "nodes": nodes,
            "reviewers": people,
            "capacity": CAPACITY,
            "dayStartMinute": 540,
            "dayEndMinute": 1020,
            "assignments": plan["assignments"],  # type: ignore[index]
        }
    )  # type: ignore[return-value]


# ------------------------------------------------------------------ happy paths


def test_assigns_every_node_and_verifies() -> None:
    plan = schedule()
    assert plan["ok"] is True
    assert plan["unscheduled"] == []
    assert len(plan["assignments"]) == 2
    assert plan["certificate"]["verified"] is True
    assert plan["certificate"]["violations"] == []


def test_a_duplicate_node_id_is_refused_outright() -> None:
    with pytest.raises(EngineError):
        schedule(nodes=[node("n1"), node("n1", effort=30)])


def test_slots_do_not_overlap_inside_one_day() -> None:
    plan = schedule(nodes=[node(f"n{i}", effort=60) for i in range(3)])
    by_slot: dict[tuple[str, str], list[tuple[int, int]]] = {}
    for item in plan["assignments"]:
        by_slot.setdefault((item["reviewerId"], item["day"]), []).append(
            (item["startMinute"], item["endMinute"])
        )
    for slots in by_slot.values():
        ordered = sorted(slots)
        for (_, first_end), (second_start, _) in zip(ordered, ordered[1:], strict=False):
            assert second_start >= first_end


def test_effort_never_exceeds_a_days_team_capacity() -> None:
    nodes = [node(f"n{i}", effort=60) for i in range(6)]
    plan = schedule_review(
        {
            "nodes": nodes,
            "reviewers": [reviewer(capacity=60)],
            "capacity": {"2026-03-02": 120},
            "dayStartMinute": 540,
            "dayEndMinute": 660,
            "mode": "best_effort",
        }
    )
    by_day: dict[str, int] = {}
    for item in plan["assignments"]:
        by_day[item["day"]] = by_day.get(item["day"], 0) + item["minutes"]
    assert all(load <= 120 for load in by_day.values())
    assert plan["certificate"]["verified"] is True


def test_capacity_is_spent_earliest_first() -> None:
    plan = schedule(
        nodes=[node("n1", effort=120)],
        capacity={"2026-03-02": 120, "2026-03-03": 120},
        reviewers=[reviewer()],
    )
    assert plan["assignments"][0]["day"] == "2026-03-02"


def test_urgent_nodes_go_first_even_when_a_quieter_one_arrives_first() -> None:
    plan = schedule(
        nodes=[
            node("later", effort=60, priority=1, deadline="2026-03-04"),
            node("urgent", effort=60, priority=100, deadline="2026-03-02"),
        ],
        capacity={"2026-03-02": 60, "2026-03-03": 60, "2026-03-04": 60},
    )
    assert [item["nodeId"] for item in plan["assignments"]] == ["urgent", "later"]


def test_a_reviewer_without_the_skill_is_never_used() -> None:
    plan = schedule(
        nodes=[node("n1", skill="phonology")],
        reviewers=[reviewer("morphologist", skills=["morphology"])],
    )
    assert plan["ok"] is False
    assert plan["reason"] == "no_eligible_reviewer"
    assert plan["witness"]["eligibleReviewers"] == []


def test_a_node_with_no_required_skill_fits_anyone() -> None:
    plan = schedule(
        nodes=[node("n1", skill=None)],
        reviewers=[reviewer("anyone", skills=[])],
    )
    assert plan["ok"] is True


def test_best_effort_keeps_what_it_can_and_reports_the_rest() -> None:
    plan = schedule(
        nodes=[node("n1", effort=60), node("n2", effort=60)],
        reviewers=[reviewer(capacity=60, days=["2026-03-02"])],
        capacity={"2026-03-02": 60},
        mode="best_effort",
    )
    assert plan["ok"] is True
    assert len(plan["assignments"]) == 1
    assert plan["unscheduled"] == ["n2"]
    assert plan["certificate"]["verified"] is True


def test_an_undeclared_day_still_holds_its_reviewers_capacity() -> None:
    # Only one reviewer, 60 minutes a day, and two days that the team capacity never names.
    plan = schedule(
        nodes=[node("n1", effort=60), node("n2", effort=60)],
        reviewers=[reviewer(capacity=60)],
        capacity={},
        mode="best_effort",
    )
    assert [item["day"] for item in plan["assignments"]] == ["2026-03-02", "2026-03-03"]
    assert plan["certificate"]["verified"] is True


def test_all_or_nothing_refuses_a_partial_plan() -> None:
    plan = schedule(
        nodes=[node("n1", effort=60), node("n2", effort=60)],
        reviewers=[reviewer(capacity=60, days=["2026-03-02"])],
        capacity={"2026-03-02": 60},
        mode="all_or_nothing",
    )
    assert plan["ok"] is False
    assert plan["assignments"] == []
    assert plan["unscheduled"] == ["n1", "n2"]


def test_an_impossible_deadline_is_reported_with_a_witness() -> None:
    plan = schedule(
        nodes=[node("n1", effort=60, deadline="2026-03-01")],
        capacity=CAPACITY,
    )
    assert plan["ok"] is False
    assert plan["reason"] == "no_capacity_before_deadline"
    assert plan["witness"]["nodeId"] == "n1"


def test_the_certificate_reports_residual_capacity() -> None:
    plan = schedule(nodes=[node("n1", effort=60)])
    residual = plan["certificate"]["residualByDay"]
    assert residual["2026-03-02"] == 120
    assert plan["certificate"]["scheduledMinutes"] == 60
    assert plan["certificate"]["totalEffortMinutes"] == 60


def test_no_nodes_is_a_valid_empty_plan() -> None:
    plan = schedule(nodes=[])
    assert plan["ok"] is True
    assert plan["assignments"] == []
    assert plan["certificate"]["verified"] is True
    assert plan["certificate"]["windowMinutes"] > 0


# ------------------------------------------------------------------ the verifier


def test_the_verifier_catches_an_oversubscribed_reviewer() -> None:
    nodes = [node("n1", effort=60), node("n2", effort=60)]
    people = [reviewer(capacity=60)]
    hand_made = {
        "assignments": [
            {"nodeId": "n1", "reviewerId": "r1", "day": "2026-03-02",
             "startMinute": 540, "endMinute": 600, "minutes": 60},
            {"nodeId": "n2", "reviewerId": "r1", "day": "2026-03-02",
             "startMinute": 540, "endMinute": 600, "minutes": 60},
        ]
    }
    result = verify(hand_made, nodes, people)
    assert result["feasible"] is False
    codes = {item["code"] for item in result["violations"]}
    assert "overlapping_slots" in codes
    assert "reviewer_oversubscribed" in codes


def test_the_verifier_catches_an_overloaded_day() -> None:
    nodes = [node("n1", effort=100)]
    people = [reviewer(capacity=100)]
    hand_made = {
        "assignments": [
            {"nodeId": "n1", "reviewerId": "r1", "day": "2026-03-02",
             "startMinute": 540, "endMinute": 640, "minutes": 100}
        ]
    }
    result = verify_plan(
        {
            "nodes": nodes,
            "reviewers": people,
            "capacity": {"2026-03-02": 60},
            "dayStartMinute": 540,
            "dayEndMinute": 1020,
            "assignments": hand_made["assignments"],
        }
    )
    assert result["feasible"] is False
    assert [item["code"] for item in result["violations"]] == ["day_oversubscribed"]


@pytest.mark.parametrize(
    ("override", "expected"),
    [
        ({"startMinute": 100, "endMinute": 160}, "outside_working_window"),
        ({"startMinute": 540, "endMinute": 1200}, "outside_working_window"),
        ({"startMinute": 600, "endMinute": 540}, "non_positive_slot"),
        ({"startMinute": 540, "endMinute": 555}, "effort_mismatch"),
        ({"day": "2026-03-09"}, "reviewer_unavailable"),
        ({"reviewerId": "ghost"}, "unknown_reviewer"),
        ({"nodeId": "ghost"}, "unknown_node"),
    ],
)
def test_the_verifier_names_each_kind_of_fault(
    override: dict[str, object], expected: str
) -> None:
    assignment = {
        "nodeId": "n1", "reviewerId": "r1", "day": "2026-03-02",
        "startMinute": 540, "endMinute": 600, "minutes": 60,
    }
    assignment.update(override)
    result = verify_plan(
        {
            "nodes": [node("n1")],
            "reviewers": [reviewer()],
            "capacity": CAPACITY,
            "dayStartMinute": 540,
            "dayEndMinute": 1020,
            "assignments": [assignment],
        }
    )
    assert result["feasible"] is False
    assert expected in {item["code"] for item in result["violations"]}


def test_the_verifier_catches_a_missing_skill_and_a_missed_deadline() -> None:
    nodes = [node("n1", effort=60, skill="phonology", deadline="2026-03-02")]
    people = [reviewer(skills=["morphology"])]
    result = verify_plan(
        {
            "nodes": nodes,
            "reviewers": people,
            "capacity": CAPACITY,
            "dayStartMinute": 540,
            "dayEndMinute": 1020,
            "assignments": [
                {"nodeId": "n1", "reviewerId": "r1", "day": "2026-03-04",
                 "startMinute": 540, "endMinute": 600, "minutes": 60}
            ],
        }
    )
    codes = {item["code"] for item in result["violations"]}
    assert codes == {"missing_skill", "deadline_missed"}


def test_the_verifier_catches_a_duplicated_node() -> None:
    one = {
        "nodeId": "n1", "reviewerId": "r1", "day": "2026-03-02",
        "startMinute": 540, "endMinute": 600, "minutes": 60,
    }
    two = dict(one, startMinute=600, endMinute=660)
    result = verify_plan(
        {
            "nodes": [node("n1")],
            "reviewers": [reviewer()],
            "capacity": CAPACITY,
            "dayStartMinute": 540,
            "dayEndMinute": 1020,
            "assignments": [one, two],
        }
    )
    assert "duplicate_assignment" in {item["code"] for item in result["violations"]}


def test_an_empty_plan_is_trivially_feasible() -> None:
    assert verify_plan({"nodes": [], "reviewers": [], "assignments": []}) == {
        "feasible": True,
        "violations": [],
        "checked": 0,
    }


@pytest.mark.parametrize(
    "payload",
    [
        {"nodes": "nope", "reviewers": [], "capacity": {}},
        {"nodes": [], "reviewers": "nope", "capacity": {}},
        {"nodes": [{"id": "a", "effortMinutes": 0}], "reviewers": [], "capacity": {}},
        {"nodes": [{"id": "a", "effortMinutes": "lots"}], "reviewers": [], "capacity": {}},
        {"nodes": [{"id": "a", "effortMinutes": 5}, {"id": "a", "effortMinutes": 5}],
         "reviewers": [], "capacity": {}},
        {"nodes": [], "reviewers": [{"id": "r"}], "capacity": {}},
        {"nodes": [], "reviewers": [{"id": "r", "capacityMinutesPerDay": -1}],
         "capacity": {}},
        {"nodes": [], "reviewers": [], "capacity": {"d": -1}},
        {"nodes": [], "reviewers": [], "capacity": {}, "dayStartMinute": 600,
         "dayEndMinute": 600},
        {"nodes": [], "reviewers": [], "capacity": {}, "dayStartMinute": -1},
        "not an object",
    ],
)
def test_schedule_review_rejects_malformed_input(payload: object) -> None:
    with pytest.raises(EngineError):
        schedule_review(payload)  # type: ignore[arg-type]


@pytest.mark.parametrize(
    "payload",
    [
        {"nodes": [], "reviewers": [], "assignments": "nope"},
        {"nodes": [], "reviewers": [], "assignments": [{"nodeId": 1}]},
        {"nodes": [], "reviewers": [], "assignments": [{"nodeId": "a"}]},
        {"nodes": [], "reviewers": [], "assignments": [], "capacity": []},
        {"nodes": [], "reviewers": [], "assignments": [], "dayStartMinute": 600,
         "dayEndMinute": 600},
        "not an object",
    ],
)
def test_verify_plan_rejects_malformed_input(payload: object) -> None:
    with pytest.raises(EngineError):
        verify_plan(payload)  # type: ignore[arg-type]


def test_an_unknown_mode_is_refused() -> None:
    with pytest.raises(EngineError):
        schedule(mode="whatever")  # type: ignore[arg-type]


# ------------------------------------------------------------------ property tests

strategies = st.integers(min_value=5, max_value=120)
identifiers = st.integers(min_value=0, max_value=6)


@settings(max_examples=120, deadline=None)
@given(efforts=st.lists(strategies, min_size=1, max_size=6), capacity=strategies)
def test_a_feasible_plan_always_verifies(efforts: list[int], capacity: int) -> None:
    nodes = [node(f"n{index}", effort=effort) for index, effort in enumerate(efforts)]
    people = [reviewer(capacity=capacity), reviewer("r2", capacity=capacity)]
    plan = schedule_review(
        {
            "nodes": nodes,
            "reviewers": people,
            "capacity": {day: capacity * 2 for day in DAYS},
            "dayStartMinute": 540,
            "dayEndMinute": 1020,
            "mode": "best_effort",
        }
    )
    assert plan["certificate"]["verified"] is True
    assert plan["certificate"]["violations"] == []
    checked = verify_plan(
        {
            "nodes": nodes,
            "reviewers": people,
            "capacity": {day: capacity * 2 for day in DAYS},
            "dayStartMinute": 540,
            "dayEndMinute": 1020,
            "assignments": plan["assignments"],
        }
    )
    assert checked["feasible"] is True


@settings(max_examples=120, deadline=None)
@given(efforts=st.lists(strategies, min_size=1, max_size=6), capacity=strategies)
def test_effort_is_conserved(efforts: list[int], capacity: int) -> None:
    nodes = [node(f"n{index}", effort=effort) for index, effort in enumerate(efforts)]
    plan = schedule_review(
        {
            "nodes": nodes,
            "reviewers": [reviewer(capacity=capacity)],
            "capacity": {day: capacity for day in DAYS},
            "dayStartMinute": 540,
            "dayEndMinute": 1020,
            "mode": "best_effort",
        }
    )
    placed = [item["nodeId"] for item in plan["assignments"]]
    assert len(placed) == len(set(placed))
    assert len(placed) + len(plan["unscheduled"]) == len(nodes)


@settings(max_examples=100, deadline=None)
@given(efforts=st.lists(strategies, min_size=1, max_size=5), capacity=strategies)
def test_scheduling_is_deterministic(efforts: list[int], capacity: int) -> None:
    nodes = [node(f"n{index}", effort=effort) for index, effort in enumerate(efforts)]
    payload = {
        "nodes": nodes,
        "reviewers": [reviewer()],
        "capacity": {day: capacity for day in DAYS},
        "dayStartMinute": 540,
        "dayEndMinute": 1020,
    }
    assert schedule_review(payload) == schedule_review(payload)  # type: ignore[arg-type]
