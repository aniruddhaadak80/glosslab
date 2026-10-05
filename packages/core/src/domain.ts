/**
 * The domain vocabulary, mirrored from `services/engine/src/glosslab/types.py`.
 *
 * These types are the JSON wire format. The engine is the only thing that produces them and
 * the only thing that consumes them, so a mismatch between this file and the Python one is
 * a bug in one of them — never a conversion layer to paper over it.
 *
 * `mypy --strict` guards the Python side; `tsc --strict` guards this one.
 */

export type FeatureAtom = string | number | boolean

/** A feature value is an atom, a nested structure, or a reference into the dictionary. */
export type FeatureValue = FeatureAtom | FeatureStructure

export interface FeatureStructure {
  readonly [feature: string]: FeatureValue
}

/** `{"@ref": "<lexemeId>:<featureName>"}` */
export interface FeatureRef {
  readonly '@ref': string
}

export type FeatureDictionary = Readonly<Record<string, FeatureStructure>>

export const MORPHEME_TYPES = ['stem', 'prefix', 'suffix', 'infix', 'clitic', 'unknown'] as const

export type MorphemeType = (typeof MORPHEME_TYPES)[number]

export const REVIEW_KINDS = ['unsegmentable', 'ambiguous', 'gap', 'feature_conflict', 'manual'] as const

export type ReviewKind = (typeof REVIEW_KINDS)[number]

// ---------------------------------------------------------------- morphology

export interface Lexeme {
  readonly id: string
  readonly morph: string
  readonly type: MorphemeType | string
  readonly gloss: string
  readonly weight: number
  readonly priority: number
  readonly features: FeatureStructure
}

/** The declared morphotactics. The engine never invents a rule that is not here. */
export interface Grammar {
  readonly maxAffixes?: number
  readonly allowPrefixStack?: boolean
  readonly allowInfix?: boolean
  readonly allowGap?: boolean
  readonly gapPenalty?: number
  readonly ambiguityMargin?: number
  readonly headFinalTypes?: readonly string[]
  readonly requiredFeatures?: readonly string[]
}

export interface SegmentInput {
  readonly word: string
  readonly lexemes: readonly Lexeme[]
  readonly grammar?: Grammar
  readonly dictionary?: FeatureDictionary
}

export interface SegmentedMorpheme {
  readonly lexemeId: string
  readonly morph: string
  readonly type: string
  readonly gloss: string
  readonly features: FeatureStructure
  readonly start: number
  readonly end: number
  readonly weight: number
  readonly known: boolean
}

export interface ScorePart {
  readonly lexemeId: string
  readonly morph: string
  readonly type: string
  readonly weight: number
  readonly start: number
  readonly end: number
}

export interface Alternate {
  readonly morphemes: readonly string[]
  readonly score: number
  readonly affixCount: number
  readonly gapCount: number
}

/** `ok: false` with a `reason` is a real answer, not an error: this word is not analysable. */
export interface SegmentOutput {
  readonly ok: boolean
  readonly word: string
  readonly morphemes: readonly SegmentedMorpheme[]
  readonly score: number
  readonly scoreBreakdown: readonly ScorePart[]
  readonly alternates: readonly Alternate[]
  readonly ambiguous: boolean
  readonly affixCount: number
  readonly gapCount: number
  readonly headFinal: boolean
  readonly reason: string | null
  readonly failedAt: readonly number[]
}

// ---------------------------------------------------------------- features

export interface UnifyInput {
  readonly left: FeatureStructure
  readonly right: FeatureStructure
  readonly dictionary?: FeatureDictionary
  readonly required?: readonly string[]
}

export interface FeatureConflict {
  readonly path: string
  readonly left: string
  readonly right: string
}

export type UnifyFailure = 'deref_fail' | 'incompatible' | 'missing'

export interface UnifyOutput {
  readonly ok: boolean
  readonly reason: UnifyFailure | null
  readonly merged: FeatureStructure
  readonly conflicts: readonly FeatureConflict[]
  readonly unspecified: readonly { readonly path: string; readonly side: string }[]
  readonly unresolvedRefs: readonly string[]
}

// ---------------------------------------------------------------- review scheduling

export interface ReviewNode {
  readonly id: string
  readonly token: string
  readonly kind: ReviewKind | string
  readonly detail: string
  readonly priority: number
  readonly effortMinutes: number
  readonly deadline: string | null
  readonly requiredSkill: string | null
}

export interface Reviewer {
  readonly id: string
  readonly skills: readonly string[]
  readonly capacityMinutesPerDay: number
  readonly availableDays: readonly string[]
}

export interface Assignment {
  readonly nodeId: string
  readonly reviewerId: string
  readonly day: string
  readonly startMinute: number
  readonly endMinute: number
  readonly minutes: number
}

export type ViolationCode =
  | 'duplicate_assignment'
  | 'unknown_node'
  | 'unknown_reviewer'
  | 'non_positive_slot'
  | 'effort_mismatch'
  | 'outside_working_window'
  | 'reviewer_unavailable'
  | 'missing_skill'
  | 'deadline_missed'
  | 'reviewer_oversubscribed'
  | 'overlapping_slots'
  | 'day_oversubscribed'

export interface Violation {
  readonly code: ViolationCode | string
  readonly detail: string
  readonly nodeId: string
  readonly reviewerId: string
  readonly day: string
}

/**
 * The proof that the plan fits. `verified` is true only when the independent verifier
 * re-derived every constraint from the plan alone and found nothing wrong.
 */
export interface Certificate {
  readonly totalEffortMinutes: number
  readonly scheduledMinutes: number
  readonly unscheduledCount: number
  readonly windowMinutes: number
  readonly utilisation: number
  readonly peakDay: string | null
  readonly peakDayLoadMinutes: number
  readonly peakDayCapacity: number
  readonly residualByDay: Readonly<Record<string, number>>
  readonly verified: boolean
  readonly violations: readonly Violation[]
}

export interface ScheduleInput {
  readonly nodes: readonly ReviewNode[]
  readonly reviewers: readonly Reviewer[]
  readonly capacity: Readonly<Record<string, number>>
  readonly dayStartMinute?: number
  readonly dayEndMinute?: number
  readonly mode?: 'all_or_nothing' | 'best_effort'
}

export interface ScheduleOutput {
  readonly ok: boolean
  readonly mode: string
  readonly reason: string | null
  readonly assignments: readonly Assignment[]
  readonly unscheduled: readonly string[]
  readonly witness: Readonly<Record<string, unknown>>
  readonly certificate: Certificate
}

export interface VerifyInput extends ScheduleInput {
  readonly assignments: readonly Assignment[]
}

export interface VerifyOutput {
  readonly feasible: boolean
  readonly violations: readonly Violation[]
  readonly checked: number
}

// ---------------------------------------------------------------- corpus analysis

export interface Token {
  readonly id: string
  readonly form: string
  readonly gloss: string
  readonly provenance: string
}

export interface CorpusInput {
  readonly language?: string
  readonly tokens: readonly Token[]
  readonly lexemes: readonly Lexeme[]
  readonly grammar?: Grammar
  readonly dictionary?: FeatureDictionary
  readonly reviewers: readonly Reviewer[]
  readonly capacity: Readonly<Record<string, number>>
  readonly dayStartMinute?: number
  readonly dayEndMinute?: number
}

export interface CorpusToken extends Token {
  readonly ok: boolean
  readonly reason: string | null
  readonly featureIssue: string | null
  readonly score: number
  readonly ambiguous: boolean
  readonly gapCount: number
  readonly morphemes: readonly SegmentedMorpheme[]
  readonly alternates: readonly Alternate[]
}

export interface CorpusAnalysis {
  readonly ok: boolean
  readonly language: string
  readonly corpusHash: string
  readonly tokens: readonly CorpusToken[]
  readonly reviewNodes: readonly ReviewNode[]
  readonly plan: ScheduleOutput
  readonly stats: Readonly<Record<string, number>>
}

/** Minutes past midnight rendered as HH:MM, for humans. Pure. */
export function formatMinute(minute: number): string {
  const hours = Math.floor(minute / 60)
  const rest = minute % 60
  return `${String(hours).padStart(2, '0')}:${String(rest).padStart(2, '0')}`
}
