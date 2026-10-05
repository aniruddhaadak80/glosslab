"""Review scheduling under real capacity limits, with a certificate you can re-check.

The question this answers is the one a documentation project actually asks: *we have three
linguists and two weeks — which of the four hundred disputed morphemes do we look at?* A
generic assistant answers with a plausible-looking list. This module answers with an
assignment plus a certificate, and then a **second, independent implementation**
(:func:`verify_plan`) re-derives every constraint from scratch and either agrees or names the
exact window that is oversubscribed.

The verifier is deliberately not a re-run of the scheduler. It never looks at how the plan
was produced; it takes only the plan and the declared capacity and checks it. That is what
makes the certificate worth something.

Pure: no clock, no network, no randomness, no filesystem. Days and minutes are strings and
integers supplied by the caller.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Final, TypedDict

from .protocol import EngineError
from .types import (
    Assignment,
    Certificate,
    ReviewNode,
    Reviewer,
    ScheduleInput,
    ScheduleOutput,
    VerifyInput,
    VerifyOutput,
    Violation,
)

DEFAULT_DAY_START: Final[int] = 9 * 60
DEFAULT_DAY_END: Final[int] = 17 * 60
# Sorts after every real ISO date, so nodes without a deadline are scheduled last.
NO_DEADLINE: Final[str] = "9999-12-31"
MODES: Final[frozenset[str]] = frozenset({"all_or_nothing", "best_effort"})


class _Placement(TypedDict):
    """One node's chosen slot, before it becomes an Assignment."""

    day: str
    start: int
    reviewer_id: str


@dataclass
class _Ledger:
    """Capacity as it is consumed, so no function needs six arguments to ask about it."""

    reviewers: list[Reviewer]
    capacity: dict[str, int]
    day_start: int
    day_end: int
    booked: dict[str, list[Assignment]] = field(default_factory=dict)
    used: dict[str, int] = field(default_factory=dict)

    def day_limit(self, day: str) -> int:
        return _day_capacity(self.reviewers, self.capacity, day)

    def booked_on(self, reviewer_id: str, day: str) -> list[Assignment]:
        return self.booked.get(f"{reviewer_id}|{day}", [])

    def reviewer_left(self, reviewer_id: str, day: str) -> int:
        limit = next(
            item["capacityMinutesPerDay"]
            for item in self.reviewers
            if item["id"] == reviewer_id
        )
        return limit - self.used.get(f"{reviewer_id}|{day}", 0)

    def day_left(self, day: str) -> int:
        return self.day_limit(day) - self.used.get(f"@{day}", 0)

    def book(self, placement: _Placement, node_id: str, minutes: int) -> Assignment:
        key = f"{placement['reviewer_id']}|{placement['day']}"
        assignment = Assignment(
            nodeId=node_id,
            reviewerId=placement["reviewer_id"],
            day=placement["day"],
            startMinute=placement["start"],
            endMinute=placement["start"] + minutes,
            minutes=minutes,
        )
        self.booked.setdefault(key, []).append(assignment)
        self.used[key] = self.used.get(key, 0) + minutes
        self.used[f"@{placement['day']}"] = self.used.get(f"@{placement['day']}", 0) + minutes
        return assignment

    def days(self) -> list[str]:
        return sorted({key[1:] for key in self.used if key.startswith("@")})


@dataclass
class _Context:
    """Everything one scheduling run needs, in one value."""

    nodes: list[ReviewNode]
    reviewers: list[Reviewer]
    ledger: _Ledger


def _parse_nodes(payload: object) -> list[ReviewNode]:
    if not isinstance(payload, list):
        raise EngineError("BAD_SHAPE", "'nodes' must be a list")
    seen: set[str] = set()
    result: list[ReviewNode] = []
    for index, raw in enumerate(payload):
        node = _node(raw, index, seen)
        result.append(node)
    return result


def _node(raw: object, index: int, seen: set[str]) -> ReviewNode:
    if not isinstance(raw, dict):
        raise EngineError("BAD_SHAPE", f"nodes[{index}] must be an object")
    node_id = raw.get("id")
    if not isinstance(node_id, str) or not node_id:
        raise EngineError("BAD_SHAPE", f"nodes[{index}] needs a non-empty string 'id'")
    if node_id in seen:
        raise EngineError("DUPLICATE", f"duplicate node id {node_id!r}")
    seen.add(node_id)
    effort = raw.get("effortMinutes")
    if not isinstance(effort, int) or effort <= 0:
        raise EngineError("BAD_SHAPE", f"node {node_id!r} needs a positive 'effortMinutes'")
    priority = raw.get("priority", 0)
    if not isinstance(priority, int):
        raise EngineError("BAD_SHAPE", f"node {node_id!r} needs an integer 'priority'")
    deadline = raw.get("deadline")
    skill = raw.get("requiredSkill")
    return ReviewNode(
        id=node_id,
        token=str(raw.get("token", "")),
        kind=str(raw.get("kind", "manual")),
        detail=str(raw.get("detail", "")),
        priority=priority,
        effortMinutes=effort,
        deadline=deadline if isinstance(deadline, str) else None,
        requiredSkill=skill if isinstance(skill, str) else None,
    )


def _parse_reviewers(payload: object) -> list[Reviewer]:
    if not isinstance(payload, list):
        raise EngineError("BAD_SHAPE", "'reviewers' must be a list")
    seen: set[str] = set()
    result: list[Reviewer] = []
    for index, raw in enumerate(payload):
        reviewer = _reviewer(raw, index, seen)
        result.append(reviewer)
    return result


def _reviewer(raw: object, index: int, seen: set[str]) -> Reviewer:
    if not isinstance(raw, dict):
        raise EngineError("BAD_SHAPE", f"reviewers[{index}] must be an object")
    reviewer_id = raw.get("id")
    if not isinstance(reviewer_id, str) or not reviewer_id:
        raise EngineError("BAD_SHAPE", f"reviewers[{index}] needs a non-empty string 'id'")
    if reviewer_id in seen:
        raise EngineError("DUPLICATE", f"duplicate reviewer id {reviewer_id!r}")
    seen.add(reviewer_id)
    capacity = raw.get("capacityMinutesPerDay")
    if not isinstance(capacity, int) or capacity < 0:
        raise EngineError(
            "BAD_SHAPE", f"reviewer {reviewer_id!r} needs a non-negative capacityMinutesPerDay"
        )
    days = raw.get("availableDays")
    if not isinstance(days, list) or any(not isinstance(day, str) for day in days):
        raise EngineError("BAD_SHAPE", f"reviewer {reviewer_id!r} needs 'availableDays'")
    skills = raw.get("skills") or []
    if not isinstance(skills, list) or any(not isinstance(skill, str) for skill in skills):
        raise EngineError("BAD_SHAPE", f"reviewer {reviewer_id!r} needs a list of 'skills'")
    return Reviewer(
        id=reviewer_id,
        skills=list(skills),
        capacityMinutesPerDay=capacity,
        availableDays=sorted(set(days)),
    )


def _minutes(payload: ScheduleInput | VerifyInput, key: str, fallback: int) -> int:
    value = payload.get(key, fallback)
    if not isinstance(value, int) or value < 0:
        raise EngineError("BAD_SHAPE", f"{key!r} must be a non-negative integer")
    return value


def _capacity(payload: ScheduleInput | VerifyInput) -> dict[str, int]:
    raw = payload.get("capacity")
    if raw is None:
        raw = {}
    if not isinstance(raw, dict):
        raise EngineError("BAD_SHAPE", "'capacity' must be an object of day -> minutes")
    result: dict[str, int] = {}
    for day, minutes in raw.items():
        if not isinstance(minutes, int) or minutes < 0:
            raise EngineError("BAD_SHAPE", f"capacity for {day!r} must be a non-negative integer")
        result[day] = minutes
    return result


def _day_capacity(reviewers: list[Reviewer], capacity: dict[str, int], day: str) -> int:
    """With no explicit team capacity, the team's limit is the sum of its reviewers'."""
    if day in capacity:
        return capacity[day]
    return sum(
        reviewer["capacityMinutesPerDay"]
        for reviewer in reviewers
        if day in reviewer["availableDays"]
    )


def _first_fit(intervals: list[Assignment], start: int, end: int, minutes: int) -> int | None:
    """Earliest start at or after ``start`` that fits ``minutes`` before ``end``."""
    cursor = start
    for busy in sorted(intervals, key=lambda item: item["startMinute"]):
        if busy["endMinute"] <= cursor:
            continue
        if busy["startMinute"] - cursor >= minutes:
            return cursor
        cursor = busy["endMinute"]
    return cursor if cursor + minutes <= end else None


def _eligible(reviewer: Reviewer, node: ReviewNode) -> bool:
    required = node["requiredSkill"]
    return required is None or required in reviewer["skills"]


def _slot(node: ReviewNode, eligible: list[Reviewer], ledger: _Ledger) -> _Placement | None:
    """The earliest legal slot for one node, or None when nothing fits."""
    deadline = node["deadline"] or NO_DEADLINE
    minutes = int(node["effortMinutes"])
    options: list[tuple[str, int, str]] = []
    for reviewer in eligible:
        for day in reviewer["availableDays"]:
            if day > deadline or ledger.reviewer_left(reviewer["id"], day) < minutes:
                continue
            if ledger.day_left(day) < minutes:
                continue
            start = _first_fit(
                ledger.booked_on(reviewer["id"], day), ledger.day_start, ledger.day_end, minutes
            )
            if start is not None:
                options.append((day, start, reviewer["id"]))
    if not options:
        return None
    day, start, reviewer_id = min(options)
    return _Placement(day=day, start=start, reviewer_id=reviewer_id)


def _witness(
    node: ReviewNode, reason: str, eligible: list[Reviewer], ledger: _Ledger
) -> dict[str, object]:
    return {
        "nodeId": node["id"],
        "reason": reason,
        "deadline": node["deadline"],
        "effortMinutes": node["effortMinutes"],
        "requiredSkill": node["requiredSkill"],
        "eligibleReviewers": [reviewer["id"] for reviewer in eligible],
        "residualByDay": {day: ledger.day_limit(day) - ledger.day_left(day) for day in ledger.days()},
    }


def _certificate(
    assignments: list[Assignment], unscheduled: list[str], context: _Context
) -> Certificate:
    ledger = context.ledger
    day_load: dict[str, int] = {}
    for item in assignments:
        day_load[item["day"]] = day_load.get(item["day"], 0) + int(item["minutes"])
    scheduled = sum(int(item["minutes"]) for item in assignments)
    window = sum(
        reviewer["capacityMinutesPerDay"] * len(reviewer["availableDays"])
        for reviewer in context.reviewers
    )
    peak_day: str | None = None
    peak_load = 0
    peak_capacity = 0
    for day in sorted(set(day_load) | set(ledger.capacity)):
        load = day_load.get(day, 0)
        if load > peak_load:
            peak_day, peak_load = day, load
            peak_capacity = ledger.day_limit(day)
    return Certificate(
        totalEffortMinutes=sum(int(node["effortMinutes"]) for node in context.nodes),
        scheduledMinutes=scheduled,
        unscheduledCount=len(unscheduled),
        windowMinutes=window,
        utilisation=round(scheduled / window, 6) if window else 0.0,
        peakDay=peak_day,
        peakDayLoadMinutes=peak_load,
        peakDayCapacity=peak_capacity,
        residualByDay={
            day: ledger.day_limit(day) - day_load.get(day, 0)
            for day in sorted(set(day_load) | set(ledger.capacity))
        },
        verified=False,
        violations=[],
    )


def _assign(context: _Context) -> tuple[list[Assignment], list[str], dict[str, object]]:
    """Earliest-deadline-first assignment with first-fit packing inside each day."""
    ledger = context.ledger
    assignments: list[Assignment] = []
    unscheduled: list[str] = []
    witness: dict[str, object] = {}

    ordered = sorted(
        context.nodes,
        key=lambda node: (node["deadline"] or NO_DEADLINE, -int(node["priority"]), node["id"]),
    )
    for node in ordered:
        eligible = [reviewer for reviewer in context.reviewers if _eligible(reviewer, node)]
        placement = _slot(node, eligible, ledger) if eligible else None
        if placement is None:
            unscheduled.append(node["id"])
            if not witness:
                witness = _witness(
                    node,
                    "no_eligible_reviewer" if not eligible else "no_capacity_before_deadline",
                    eligible,
                    ledger,
                )
            continue
        assignments.append(ledger.book(placement, node["id"], int(node["effortMinutes"])))

    assignments.sort(key=lambda item: (item["day"], item["startMinute"], item["reviewerId"]))
    return assignments, sorted(unscheduled), witness


def schedule_review(payload: ScheduleInput) -> ScheduleOutput:
    """Assign every review node to a reviewer and a slot, or explain why it cannot be done."""
    if not isinstance(payload, dict):
        raise EngineError("BAD_SHAPE", "schedule_review expects an object")
    nodes = _parse_nodes(payload.get("nodes"))
    reviewers = _parse_reviewers(payload.get("reviewers"))
    capacity = _capacity(payload)
    day_start = _minutes(payload, "dayStartMinute", DEFAULT_DAY_START)
    day_end = _minutes(payload, "dayEndMinute", DEFAULT_DAY_END)
    if day_end <= day_start:
        raise EngineError("BAD_SHAPE", "'dayEndMinute' must be after 'dayStartMinute'")
    mode = payload.get("mode", "all_or_nothing")
    if mode not in MODES:
        raise EngineError("BAD_SHAPE", "'mode' must be 'all_or_nothing' or 'best_effort'")

    context = _Context(
        nodes=nodes,
        reviewers=reviewers,
        ledger=_Ledger(
            reviewers=reviewers, capacity=capacity, day_start=day_start, day_end=day_end
        ),
    )
    assignments, unscheduled, witness = _assign(context)

    if unscheduled and mode == "all_or_nothing":
        empty: list[Assignment] = []
        certificate = _certificate(empty, unscheduled, context)
        certificate["verified"] = True
        return ScheduleOutput(
            ok=False,
            mode=str(mode),
            reason=str(witness.get("reason", "infeasible")),
            assignments=empty,
            unscheduled=sorted(node["id"] for node in nodes),
            witness=witness,
            certificate=certificate,
        )

    certificate = _certificate(assignments, unscheduled, context)
    checked = verify_plan(
        VerifyInput(
            nodes=list(nodes),
            reviewers=list(reviewers),
            capacity=dict(capacity),
            dayStartMinute=day_start,
            dayEndMinute=day_end,
            assignments=list(assignments),
        )
    )
    certificate["verified"] = bool(checked["feasible"])
    certificate["violations"] = list(checked["violations"])

    return ScheduleOutput(
        ok=True,
        mode=str(mode),
        reason=None,
        assignments=assignments,
        unscheduled=unscheduled,
        witness=witness,
        certificate=certificate,
    )


class _Checker:
    """Collects violations without threading a list through every call."""

    def __init__(self) -> None:
        self.violations: list[Violation] = []

    def fail(
        self, code: str, detail: str, node_id: str = "", reviewer_id: str = "", day: str = ""
    ) -> None:
        self.violations.append(
            Violation(
                code=code,
                detail=detail,
                nodeId=node_id,
                reviewerId=reviewer_id,
                day=day,
            )
        )


class _Audit(TypedDict):
    """The checker's working state for one pass over a plan."""

    nodes: dict[str, ReviewNode]
    reviewers: dict[str, Reviewer]
    day_start: int
    day_end: int
    seen: set[str]
    buckets: dict[tuple[str, str], list[Assignment]]
    day_minutes: dict[str, int]


def _check_assignment(checker: _Checker, raw: object, audit: _Audit) -> None:
    nodes = audit["nodes"]
    reviewers = audit["reviewers"]
    if not isinstance(raw, dict):
        raise EngineError("BAD_SHAPE", "every assignment must be an object")
    node_id, reviewer_id, day = raw.get("nodeId"), raw.get("reviewerId"), raw.get("day")
    start, end = raw.get("startMinute"), raw.get("endMinute")
    if not all(isinstance(item, str) for item in (node_id, reviewer_id, day)):
        raise EngineError("BAD_SHAPE", "an assignment needs string nodeId/reviewerId/day")
    if not isinstance(start, int) or not isinstance(end, int):
        raise EngineError("BAD_SHAPE", f"assignment {node_id!r} needs integer start/end minutes")
    identifier = str(node_id)
    who, when = str(reviewer_id), str(day)
    day_start, day_end = audit["day_start"], audit["day_end"]

    if identifier in audit["seen"]:
        checker.fail("duplicate_assignment", f"node {identifier} is scheduled twice", identifier)
    audit["seen"].add(identifier)

    node = nodes.get(identifier)
    if node is None:
        checker.fail("unknown_node", f"unknown node {identifier}", identifier)
        return
    reviewer = reviewers.get(who)
    if reviewer is None:
        checker.fail("unknown_reviewer", f"unknown reviewer {who}", identifier, who, when)
        return

    minutes = end - start
    if minutes <= 0:
        checker.fail(
            "non_positive_slot", f"slot for {identifier} ends before it starts", identifier, who, when
        )
    if minutes != int(node["effortMinutes"]):
        checker.fail(
            "effort_mismatch",
            f"node {identifier} needs {node['effortMinutes']} minutes, was given {minutes}",
            identifier,
            who,
            when,
        )
    if start < day_start or end > day_end:
        checker.fail(
            "outside_working_window",
            f"slot for {identifier} falls outside the working window",
            identifier,
            who,
            when,
        )
    if when not in reviewer["availableDays"]:
        checker.fail(
            "reviewer_unavailable", f"{who} is unavailable on {when}", identifier, who, when
        )
    required = node["requiredSkill"]
    if required is not None and required not in reviewer["skills"]:
        checker.fail(
            "missing_skill",
            f"{who} lacks {required}, needed by {identifier}",
            identifier,
            who,
            when,
        )
    deadline = node["deadline"]
    if deadline is not None and when > deadline:
        checker.fail(
            "deadline_missed",
            f"{identifier} was due {deadline} but sits on {when}",
            identifier,
            who,
            when,
        )

    audit["buckets"].setdefault((who, when), []).append(
        Assignment(
            nodeId=identifier,
            reviewerId=who,
            day=when,
            startMinute=start,
            endMinute=end,
            minutes=minutes,
        )
    )
    audit["day_minutes"][when] = audit["day_minutes"].get(when, 0) + minutes


def _check_capacity(
    checker: _Checker,
    buckets: dict[tuple[str, str], list[Assignment]],
    day_minutes: dict[str, int],
    reviewers: dict[str, Reviewer],
    capacity: dict[str, int],
) -> None:
    for (who, when), items in sorted(buckets.items()):
        reviewer = reviewers[who]
        used = sum(int(item["minutes"]) for item in items)
        if used > reviewer["capacityMinutesPerDay"]:
            checker.fail(
                "reviewer_oversubscribed",
                f"{who} is booked {used} minutes on {when}, has "
                f"{reviewer['capacityMinutesPerDay']}",
                "",
                who,
                when,
            )
        ordered = sorted(items, key=lambda item: item["startMinute"])
        for before, after in zip(ordered, ordered[1:], strict=False):
            if after["startMinute"] < before["endMinute"]:
                checker.fail(
                    "overlapping_slots",
                    f"{who} has overlapping slots on {when}",
                    after["nodeId"],
                    who,
                    when,
                )
    for when, used in sorted(day_minutes.items()):
        limit = _day_capacity(list(reviewers.values()), capacity, when)
        if used > limit:
            checker.fail(
                "day_oversubscribed",
                f"the team is booked {used} minutes on {when}, the window holds {limit}",
                "",
                "",
                when,
            )


def verify_plan(payload: VerifyInput) -> VerifyOutput:
    """Re-derive every scheduling constraint from the plan alone.

    This is a second implementation on purpose. It shares no logic with
    :func:`schedule_review` beyond input parsing, so a bug in the scheduler cannot hide
    inside its own proof.
    """
    if not isinstance(payload, dict):
        raise EngineError("BAD_SHAPE", "verify_plan expects an object")
    nodes = {node["id"]: node for node in _parse_nodes(payload.get("nodes"))}
    reviewers = {item["id"]: item for item in _parse_reviewers(payload.get("reviewers"))}
    capacity = _capacity(payload)
    day_start = _minutes(payload, "dayStartMinute", DEFAULT_DAY_START)
    day_end = _minutes(payload, "dayEndMinute", DEFAULT_DAY_END)
    if day_end <= day_start:
        raise EngineError("BAD_SHAPE", "'dayEndMinute' must be after 'dayStartMinute'")

    raw_assignments = payload.get("assignments")
    if not isinstance(raw_assignments, list):
        raise EngineError("BAD_SHAPE", "'assignments' must be a list")

    checker = _Checker()
    audit = _Audit(
        nodes=nodes,
        reviewers=reviewers,
        day_start=day_start,
        day_end=day_end,
        seen=set(),
        buckets={},
        day_minutes={},
    )
    for raw in raw_assignments:
        _check_assignment(checker, raw, audit)
    _check_capacity(checker, audit["buckets"], audit["day_minutes"], reviewers, capacity)

    checker.violations.sort(
        key=lambda item: (item["code"], item["day"], item["reviewerId"], item["nodeId"])
    )
    return VerifyOutput(
        feasible=not checker.violations,
        violations=checker.violations,
        checked=len(raw_assignments),
    )
