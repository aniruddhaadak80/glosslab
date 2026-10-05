import type { CorpusAnalysis } from '@glosslab/core'
import type { Store } from './store.js'

/**
 * The projection of a corpus analysis into SQLite.
 *
 * The append-only ledger is the source of truth and the engine is the only thing that
 * produces an analysis; this is a *derived* view, replaceable at any time by running
 * `glosslab analyze` again. That is why `replace` is a single transaction that clears and
 * rewrites: a partial projection would be worse than none, because it would answer queries
 * confidently with data that no longer matches the corpus.
 */

export interface TokenRow {
  readonly id: string
  readonly form: string
  readonly gloss: string
  readonly provenance: string
  readonly ok: number
  readonly reason: string | null
  readonly feature_issue: string | null
  readonly score: number
  readonly ambiguous: number
  readonly gap_count: number
  readonly corpus_hash: string
}

export interface MorphemeRow {
  readonly token_id: string
  readonly position: number
  readonly lexeme_id: string
  readonly morph: string
  readonly type: string
  readonly gloss: string
  readonly span_from: number
  readonly span_to: number
  readonly weight: number
  readonly known: number
  readonly features: string
}

export interface ReviewNodeRow {
  readonly id: string
  readonly token_id: string | null
  readonly token: string
  readonly kind: string
  readonly detail: string
  readonly priority: number
  readonly effort_minutes: number
  readonly deadline: string | null
  readonly required_skill: string | null
}

export interface AssignmentRow {
  readonly node_id: string
  readonly reviewer_id: string
  readonly day: string
  readonly start_minute: number
  readonly end_minute: number
  readonly minutes: number
}

export interface ProjectionResult {
  readonly tokens: number
  readonly morphemes: number
  readonly reviewNodes: number
  readonly assignments: number
  readonly corpusHash: string
}

const TABLES = ['tokens_fts', 'assignments', 'review_nodes', 'alternates', 'morphemes', 'tokens']

export class MorphologyProjection {
  readonly #store: Store

  constructor(store: Store) {
    this.#store = store
  }

  /**
   * Replace the whole projection. Idempotent: the same analysis twice leaves the same rows,
   * and a corpus edit cannot leave a stale token behind.
   */
  replace(analysis: CorpusAnalysis): ProjectionResult {
    const db = this.#store.connection
    const hash = analysis.corpusHash

    return this.#store.transaction(() => {
      for (const table of TABLES) db.prepare(`DELETE FROM ${table}`).run()

      const insertToken = db.prepare(
        `INSERT INTO tokens
           (id, form, gloss, provenance, ok, reason, feature_issue, score, ambiguous, gap_count, corpus_hash)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      const insertMorpheme = db.prepare(
        `INSERT INTO morphemes
           (token_id, position, lexeme_id, morph, type, gloss, span_from, span_to, weight, known, features)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      const insertAlternate = db.prepare(
        `INSERT INTO alternates (token_id, position, morphs, score) VALUES (?, ?, ?, ?)`,
      )
      const insertFts = db.prepare(`INSERT INTO tokens_fts (id, form, gloss, provenance) VALUES (?, ?, ?, ?)`)
      const insertNode = db.prepare(
        `INSERT INTO review_nodes
           (id, token_id, token, kind, detail, priority, effort_minutes, deadline, required_skill)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      const insertAssignment = db.prepare(
        `INSERT INTO assignments (node_id, reviewer_id, day, start_minute, end_minute, minutes)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )

      let morphemeCount = 0
      const tokenIds = new Set<string>()
      for (const token of analysis.tokens) {
        tokenIds.add(token.id)
        insertToken.run(
          token.id,
          token.form,
          token.gloss,
          token.provenance,
          token.ok ? 1 : 0,
          token.reason,
          token.featureIssue,
          token.score,
          token.ambiguous ? 1 : 0,
          token.gapCount,
          hash,
        )
        insertFts.run(token.id, token.form, token.gloss, token.provenance)
        token.morphemes.forEach((morpheme, position) => {
          insertMorpheme.run(
            token.id,
            position,
            morpheme.lexemeId,
            morpheme.morph,
            morpheme.type,
            morpheme.gloss,
            morpheme.start,
            morpheme.end,
            morpheme.weight,
            morpheme.known ? 1 : 0,
            JSON.stringify(morpheme.features),
          )
          morphemeCount += 1
        })
        token.alternates.forEach((alternate, position) => {
          insertAlternate.run(token.id, position, JSON.stringify(alternate.morphemes), alternate.score)
        })
      }

      for (const node of analysis.reviewNodes) {
        // A review node id encodes its token ("t07:ambiguous"), but a caller may project a
        // node whose token is not in this corpus. Store NULL rather than violate the key.
        const candidate = node.id.split(':')[0]
        const tokenId = candidate !== undefined && tokenIds.has(candidate) ? candidate : null
        insertNode.run(
          node.id,
          tokenId,
          node.token,
          node.kind,
          node.detail,
          node.priority,
          node.effortMinutes,
          node.deadline,
          node.requiredSkill,
        )
      }

      for (const assignment of analysis.plan.assignments) {
        insertAssignment.run(
          assignment.nodeId,
          assignment.reviewerId,
          assignment.day,
          assignment.startMinute,
          assignment.endMinute,
          assignment.minutes,
        )
      }

      return {
        tokens: analysis.tokens.length,
        morphemes: morphemeCount,
        reviewNodes: analysis.reviewNodes.length,
        assignments: analysis.plan.assignments.length,
        corpusHash: hash,
      }
    })
  }

  /** Every token, or only those needing review, in corpus order. */
  tokens(needsReviewOnly = false): readonly TokenRow[] {
    const sql = needsReviewOnly
      ? `SELECT t.* FROM tokens t
           WHERE t.ok = 0 OR t.feature_issue IS NOT NULL OR t.ambiguous = 1 OR t.gap_count > 0
           ORDER BY t.form`
      : 'SELECT * FROM tokens ORDER BY id'
    return this.#store.connection.prepare(sql).all() as TokenRow[]
  }

  token(id: string): TokenRow | undefined {
    return this.#store.connection.prepare('SELECT * FROM tokens WHERE id = ?').get(id) as TokenRow | undefined
  }

  morphemesOf(tokenId: string): readonly MorphemeRow[] {
    return this.#store.connection
      .prepare('SELECT * FROM morphemes WHERE token_id = ? ORDER BY position')
      .all(tokenId) as MorphemeRow[]
  }

  reviewNodes(): readonly ReviewNodeRow[] {
    return this.#store.connection
      .prepare('SELECT * FROM review_nodes ORDER BY priority DESC, id')
      .all() as ReviewNodeRow[]
  }

  assignments(): readonly AssignmentRow[] {
    return this.#store.connection
      .prepare('SELECT * FROM assignments ORDER BY day, start_minute, reviewer_id')
      .all() as AssignmentRow[]
  }

  /** Distinct lexemes the corpus actually used, with how often. */
  lexemeUsage(): readonly { lexeme_id: string; morph: string; type: string; uses: number }[] {
    return this.#store.connection
      .prepare(
        `SELECT m.lexeme_id, m.morph, m.type, COUNT(*) AS uses
           FROM morphemes m GROUP BY m.lexeme_id, m.morph, m.type
           ORDER BY uses DESC, m.lexeme_id`,
      )
      .all() as { lexeme_id: string; morph: string; type: string; uses: number }[]
  }

  /**
   * Phrase search over forms, glosses and provenance.
   *
   * The query is quoted rather than passed through, because FTS5's grammar treats punctuation
   * as syntax — `zzz-nothing` is a column reference to FTS5, not a phrase, and letting raw
   * input reach the grammar turns a search box into a syntax error at best.
   */
  search(query: string): readonly TokenRow[] {
    const phrase = `"${query.replaceAll('"', '""')}"`
    return this.#store.connection
      .prepare(
        `SELECT t.* FROM tokens_fts f JOIN tokens t ON t.id = f.id
         WHERE tokens_fts MATCH ? ORDER BY rank`,
      )
      .all(phrase) as TokenRow[]
  }

  /** Load the projection into memory — what the TUI and the API both want. */
  exportAnalysis(analysis: CorpusAnalysis): ProjectionResult {
    return this.replace(analysis)
  }
}
