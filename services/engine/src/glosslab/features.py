"""Feature-structure unification.

Morphological analysis is not really about cutting words into pieces; it is about asking
whether the pieces you found can agree on their features. A plural marker and a singular
noun cannot unify. This module answers that question, and answers it exactly the same way
every time, which is why it is code and not a model call.

Three kinds of failure, reported separately because they mean different things to a linguist:

- ``deref_fail``   a ``{"@ref": "id:feature"}`` pointed at something that does not exist.
- ``incompatible`` two sides gave the same feature different values.
- ``missing``      a feature the caller declared required was specified by only one side, or
                   by neither.

Pure: no clock, no network, no randomness, no filesystem. Time and identity are irrelevant
to whether two feature structures unify.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Final, TypeGuard, TypedDict

from .protocol import EngineError
from .types import (
    FeatureDictionary,
    FeatureRef,
    FeatureStructure,
    FeatureValue,
)

MAX_DEPTH: Final[int] = 64


class Conflict(TypedDict):
    """One feature two sides disagreed about."""

    path: str
    left: str
    right: str


class Unspecified(TypedDict):
    """One feature only one side mentioned."""

    path: str
    side: str


class UnifyInput(TypedDict, total=False):
    left: FeatureStructure
    right: FeatureStructure
    dictionary: FeatureDictionary
    required: list[str]


class UnifyOutput(TypedDict):
    ok: bool
    reason: str | None
    merged: FeatureStructure
    conflicts: list[Conflict]
    unspecified: list[Unspecified]
    unresolvedRefs: list[str]


@dataclass
class _Sink:
    """Everything a merge records, so the recursion does not carry four lists."""

    conflicts: list[Conflict] = field(default_factory=list)
    unspecified: list[Unspecified] = field(default_factory=list)
    unresolved: list[str] = field(default_factory=list)


def is_structure(value: FeatureValue) -> TypeGuard[FeatureStructure]:
    return isinstance(value, dict) and not is_reference(value)


def is_reference(value: FeatureValue) -> TypeGuard[FeatureRef]:
    """A reference is a one-key dict whose only key is ``@ref``."""
    return isinstance(value, dict) and set(value.keys()) == {"@ref"}


def render(value: FeatureValue) -> str:
    """Render a value for a human-readable conflict message."""
    if is_reference(value):
        return f"@{value['@ref']}"
    if is_structure(value):
        return "{" + ", ".join(f"{key}={render(value[key])}" for key in sorted(value)) + "}"
    if isinstance(value, bool):
        return "true" if value else "false"
    return str(value)


def _join(path: str, key: str) -> str:
    return key if not path else f"{path}.{key}"


class _Unifier:
    """Merges values against a feature dictionary, recording every disagreement."""

    def __init__(self, dictionary: FeatureDictionary) -> None:
        self.dictionary = dictionary
        self.sink = _Sink()

    def resolve(self, value: FeatureValue) -> FeatureValue:
        """Follow a reference chain to the value it names.

        A dangling reference is recorded and returned unchanged, so a caller can see how far
        the merge got even when the input is broken.
        """
        current = value
        for _ in range(MAX_DEPTH):
            if not is_reference(current):
                return current
            ref = current["@ref"]
            identifier, separator, feature = ref.partition(":")
            target = self.dictionary.get(identifier) if separator else None
            if target is None or feature not in target:
                self.sink.unresolved.append(ref)
                return current
            current = target[feature]
        self.sink.unresolved.append(render(value))
        return current

    def merge(
        self, left: FeatureValue, right: FeatureValue, path: str = "", depth: int = 0
    ) -> FeatureValue:
        """Merge two values, recording rather than resolving what they disagree about."""
        if depth > MAX_DEPTH:
            raise EngineError(
                "TOO_DEEP",
                f"feature structures nested deeper than {MAX_DEPTH} at {path or '<root>'}",
            )
        a = self.resolve(left)
        b = self.resolve(right)

        if is_structure(a) and is_structure(b):
            merged: FeatureStructure = {}
            for key in sorted(set(a) | set(b)):
                here = _join(path, key)
                if key not in a:
                    self.sink.unspecified.append(Unspecified(path=here, side="left"))
                    # Resolve even when only one side has the feature: a reference that
                    # dangles on one side alone is still a broken input, not a pass.
                    merged[key] = self.resolve(b[key])
                elif key not in b:
                    self.sink.unspecified.append(Unspecified(path=here, side="right"))
                    merged[key] = self.resolve(a[key])
                else:
                    merged[key] = self.merge(a[key], b[key], here, depth + 1)
            return merged

        if a == b:
            return a
        self.sink.conflicts.append(
            Conflict(path=path, left=render(a), right=render(b))
        )
        return a


def lookup(structure: FeatureStructure, path: str) -> FeatureValue | None:
    """Walk a dotted path. Returns None when any step is missing."""
    current: FeatureValue = structure
    for part in path.split("."):
        if not is_structure(current):
            return None
        if part not in current:
            return None
        current = current[part]
    return current


def _require_structure(payload: UnifyInput, key: str) -> FeatureStructure:
    value = payload.get(key)
    if not isinstance(value, dict):
        raise EngineError("BAD_SHAPE", f"{key!r} must be an object")
    return value


def unify(payload: UnifyInput) -> UnifyOutput:
    """Unify two feature structures under an optional feature dictionary."""
    if not isinstance(payload, dict):
        raise EngineError("BAD_SHAPE", "unify expects an object with 'left' and 'right'")

    left = _require_structure(payload, "left")
    right = _require_structure(payload, "right")

    raw_dictionary = payload.get("dictionary")
    if raw_dictionary is None:
        raw_dictionary = {}
    if not isinstance(raw_dictionary, dict):
        raise EngineError("BAD_SHAPE", "'dictionary' must be an object")
    dictionary: FeatureDictionary = {
        key: value for key, value in raw_dictionary.items() if isinstance(value, dict)
    }

    raw_required = payload.get("required")
    if raw_required is None:
        raw_required = []
    if not isinstance(raw_required, list) or any(
        not isinstance(item, str) for item in raw_required
    ):
        raise EngineError("BAD_SHAPE", "'required' must be a list of dotted paths")

    unifier = _Unifier(dictionary)
    merged = unifier.merge(left, right)
    if not is_structure(merged):
        raise EngineError("INTERNAL", "merging two feature structures must yield a structure")

    missing = [path for path in raw_required if lookup(merged, path) is None]

    reason: str | None
    if unifier.sink.unresolved:
        reason = "deref_fail"
    elif unifier.sink.conflicts:
        reason = "incompatible"
    elif missing:
        reason = "missing"
    else:
        reason = None

    return UnifyOutput(
        ok=reason is None,
        reason=reason,
        merged=merged,
        conflicts=unifier.sink.conflicts,
        unspecified=unifier.sink.unspecified,
        unresolvedRefs=sorted(set(unifier.sink.unresolved)),
    )
