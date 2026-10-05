"""The domain vocabulary of the engine, in one place.

Every operation in this package speaks these types and nothing else. They are `TypedDict`s
rather than dataclasses because they are also the JSON wire format: the TypeScript side
mirrors them in `packages/core/src/domain.ts`, and a mismatch between the two is a bug in
one of them, not a conversion layer.

Nothing here is imported at runtime except the aliases, so this module has no behaviour to
test on its own.
"""

from __future__ import annotations

from typing import Literal, TypeAlias, TypedDict

# ---------------------------------------------------------------- features

FeatureAtom: TypeAlias = str | bool | int | float

# A feature value is an atom, a nested structure, or a reference into the feature dictionary.
# The reference is spelled {"@ref": "<lexemeId>:<featureName>"}.
FeatureStructure: TypeAlias = dict[str, "FeatureValue"]
FeatureRef: TypeAlias = dict[str, str]
FeatureValue: TypeAlias = FeatureAtom | FeatureStructure | FeatureRef

# id -> that lexeme's feature structure. References are resolved against this.
FeatureDictionary: TypeAlias = dict[str, FeatureStructure]

# ---------------------------------------------------------------- morphology

MORPHEME_TYPES: frozenset[str] = frozenset(
    {"stem", "prefix", "suffix", "infix", "clitic", "unknown"}
)

# The kinds of review node the product can raise. These are the product's vocabulary of
# "this needs a human", and they are deliberately disjoint.
REVIEW_KINDS: frozenset[str] = frozenset(
    {"ambiguous", "gap", "unsegmentable", "feature_conflict", "manual"}
)


class Lexeme(TypedDict):
    """One entry in a morpheme lexicon."""

    id: str
    morph: str
    type: str
    gloss: str
    weight: float
    priority: int
    features: FeatureStructure


class Grammar(TypedDict, total=False):
    """The declared morphotactics. The engine never invents a rule that is not here."""

    maxAffixes: int
    allowPrefixStack: bool
    allowInfix: bool
    allowGap: bool
    gapPenalty: float
    ambiguityMargin: float
    headFinalTypes: list[str]
    requiredFeatures: list[str]


class SegmentInput(TypedDict, total=False):
    word: str
    lexemes: list[Lexeme]
    grammar: Grammar
    dictionary: FeatureDictionary


class SegmentedMorpheme(TypedDict):
    lexemeId: str
    morph: str
    type: str
    gloss: str
    features: FeatureStructure
    start: int
    end: int
    weight: float
    known: bool


class ScorePart(TypedDict):
    lexemeId: str
    morph: str
    type: str
    weight: float
    start: int
    end: int


class Alternate(TypedDict):
    morphemes: list[str]
    score: float
    affixCount: int
    gapCount: int


class SegmentOutput(TypedDict):
    ok: bool
    word: str
    morphemes: list[SegmentedMorpheme]
    score: float
    scoreBreakdown: list[ScorePart]
    alternates: list[Alternate]
    ambiguous: bool
    affixCount: int
    gapCount: int
    headFinal: bool
    reason: str | None
    failedAt: list[int]


# ---------------------------------------------------------------- review scheduling

ReviewKind: TypeAlias = Literal[
    "ambiguous", "gap", "unsegmentable", "feature_conflict", "manual"
]


class ReviewNode(TypedDict):
    """One thing a human has to look at."""

    id: str
    token: str
    kind: str
    detail: str
    priority: int
    effortMinutes: int
    deadline: str | None
    requiredSkill: str | None


class Reviewer(TypedDict):
    id: str
    skills: list[str]
    capacityMinutesPerDay: int
    availableDays: list[str]


class Assignment(TypedDict):
    nodeId: str
    reviewerId: str
    day: str
    startMinute: int
    endMinute: int
    minutes: int


class Violation(TypedDict):
    code: str
    detail: str
    nodeId: str
    reviewerId: str
    day: str


class Certificate(TypedDict):
    totalEffortMinutes: int
    scheduledMinutes: int
    unscheduledCount: int
    windowMinutes: int
    utilisation: float
    peakDay: str | None
    peakDayLoadMinutes: int
    peakDayCapacity: int
    residualByDay: dict[str, int]
    verified: bool
    violations: list[Violation]


class ScheduleInput(TypedDict, total=False):
    nodes: list[ReviewNode]
    reviewers: list[Reviewer]
    capacity: dict[str, int]
    dayStartMinute: int
    dayEndMinute: int
    mode: str


class ScheduleOutput(TypedDict):
    ok: bool
    mode: str
    reason: str | None
    assignments: list[Assignment]
    unscheduled: list[str]
    witness: dict[str, object]
    certificate: Certificate


class VerifyInput(TypedDict, total=False):
    nodes: list[ReviewNode]
    reviewers: list[Reviewer]
    capacity: dict[str, int]
    dayStartMinute: int
    dayEndMinute: int
    assignments: list[Assignment]


class VerifyOutput(TypedDict):
    feasible: bool
    violations: list[Violation]
    checked: int


# ---------------------------------------------------------------- corpus analysis


class Token(TypedDict, total=False):
    id: str
    form: str
    gloss: str
    provenance: str


class CorpusInput(TypedDict, total=False):
    tokens: list[Token]
    lexemes: list[Lexeme]
    grammar: Grammar
    dictionary: FeatureDictionary
    reviewers: list[Reviewer]
    capacity: dict[str, int]
    dayStartMinute: int
    dayEndMinute: int
    defaultEffortMinutes: int


class CorpusToken(TypedDict):
    id: str
    form: str
    gloss: str
    provenance: str
    ok: bool
    reason: str | None
    featureIssue: str | None
    score: float
    ambiguous: bool
    gapCount: int
    morphemes: list[SegmentedMorpheme]
    alternates: list[Alternate]


class CorpusOutput(TypedDict):
    ok: bool
    language: str
    corpusHash: str
    tokens: list[CorpusToken]
    reviewNodes: list[ReviewNode]
    plan: ScheduleOutput
    stats: dict[str, int | float]
