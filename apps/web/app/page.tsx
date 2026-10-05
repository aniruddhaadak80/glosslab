import Link from 'next/link'
import {
  AnalysisUnavailable,
  disputeOf,
  filterTokens,
  formatPercent,
  loadAnalysis,
  padEnd,
  type CorpusToken,
} from '../lib/analysis'

/**
 * The corpus browser: a dense token list on the left, the interlinear gloss on the right.
 *
 * Server-rendered and interactive without a line of client JavaScript — the search is a GET
 * form and the selection is a link, so the whole primary flow works with scripting disabled
 * and stays keyboard-navigable for free.
 */

/**
 * Deliberately dynamic: the filter and the selected token arrive as query parameters, and
 * `force-static` would make Next ignore them at request time — the page would render, and the
 * selection would quietly do nothing. Server-rendered per request, no client JavaScript.
 */

const TONE: Record<string, 'ok' | 'warn' | 'danger' | 'accent'> = {
  unsegmentable: 'danger',
  feature_conflict: 'danger',
  ambiguous: 'accent',
  gap: 'warn',
}

const LABEL: Record<string, string> = {
  unsegmentable: 'unsegmentable',
  feature_conflict: 'feature clash',
  ambiguous: 'ambiguous',
  gap: 'gap',
}

function Gloss({ token }: { token: CorpusToken }) {
  const widths = token.morphemes.map((morpheme) => Math.max(morpheme.morph.length, morpheme.gloss.length, 1))
  const glosses = token.morphemes
    .map((morpheme, index) => padEnd(morpheme.gloss, widths[index] ?? 1))
    .join(' ')
    .trimEnd()
  const ticks = token.morphemes.map((morpheme, index) => `│${'─'.repeat((widths[index] ?? 1) - 1)}`).join('')
  const forms = token.morphemes.map((morpheme, index) => padEnd(morpheme.morph, widths[index] ?? 1)).join(' ')

  return (
    <div className="gloss">
      <span className="gloss-row gloss-head">
        <strong>{token.form}</strong> <span className="muted">{token.gloss}</span>{' '}
        <span className="faint">({token.provenance})</span>
      </span>
      <span className="gloss-row gloss-glosses">{glosses}</span>
      <span className="gloss-row gloss-ticks">{ticks}</span>
      <span className="gloss-row gloss-forms">{forms}</span>
    </div>
  )
}

function Detail({ token }: { token: CorpusToken }) {
  const dispute = disputeOf(token)

  if (!token.ok) {
    return (
      <>
        <div className="notice" data-tone="danger">
          <strong>No reading.</strong> The declared lexicon has no path through this form
          {token.reason === 'unsegmentable' ? ' — every position must be covered by a lexeme' : ''}. Glosslab
          will not guess a boundary here; add the morphemes to the lexicon and re-run{' '}
          <code>glosslab analyze</code>.
        </div>
        <Gloss token={token} />
      </>
    )
  }

  return (
    <>
      <Gloss token={token} />
      <dl className="morph-grid">
        {token.morphemes.map((morpheme, index) => (
          <div className="morph" key={`${morpheme.lexemeId}-${index}`} data-disputed={dispute !== null}>
            <dt>
              {index} · {morpheme.type}
            </dt>
            <dd className="mono">{morpheme.morph}</dd>
            <dt>gloss</dt>
            <dd>{morpheme.gloss}</dd>
            <dt>characters</dt>
            <dd className="mono">
              {morpheme.start}–{morpheme.end}
            </dd>
            <dt>features</dt>
            <dd className="mono">
              {Object.keys(morpheme.features).length === 0
                ? '—'
                : Object.entries(morpheme.features)
                    .map(([key, value]) => `${key}=${String(value)}`)
                    .join(' ')}
            </dd>
          </div>
        ))}
      </dl>
      {token.featureIssue !== null && (
        <div className="notice" data-tone="danger">
          <strong>Feature clash.</strong> {token.featureIssue}
        </div>
      )}
      {token.alternates.length > 0 && (
        <table className="plan-table">
          <caption className="faint">
            Readings within the declared ambiguity margin. The chosen reading is first.
          </caption>
          <thead>
            <tr>
              <th>reading</th>
              <th>score</th>
              <th>affixes</th>
              <th>gaps</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>{token.morphemes.map((morpheme) => morpheme.morph).join('-')}</td>
              <td>{token.score}</td>
              <td>{token.morphemes.filter((morpheme) => morpheme.type !== 'stem').length}</td>
              <td>{token.gapCount}</td>
            </tr>
            {token.alternates.map((alternate, index) => (
              <tr key={index}>
                <td>{alternate.morphemes.join('-')}</td>
                <td>{alternate.score}</td>
                <td>{alternate.affixCount}</td>
                <td>{alternate.gapCount}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  )
}

export default async function CorpusPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; token?: string }>
}) {
  const params = await searchParams
  const query = params.q ?? ''
  const requested = params.token ?? null

  let analysis
  try {
    analysis = loadAnalysis()
  } catch (cause) {
    if (cause instanceof AnalysisUnavailable) {
      return (
        <div className="state" data-kind="error">
          <h2>No corpus artifact</h2>
          <p className="mono">{cause.message}</p>
          <p>Run the engine and commit the result: glosslab analyze --write</p>
        </div>
      )
    }
    throw cause
  }

  const all = analysis.tokens
  const rows = filterTokens(all, query)
  const disputedCount = all.filter((token) => disputeOf(token) !== null).length
  const selected =
    (requested === null ? null : all.find((token) => token.id === requested)) ?? rows[0] ?? null

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Corpus</h1>
          <p>
            {analysis.language} · {all.length} tokens · {disputedCount} need a human · hash{' '}
            <span className="mono">{analysis.corpusHash}</span>
          </p>
        </div>
        <form className="search" action="/" method="get" role="search">
          <label className="faint" htmlFor="q">
            filter
          </label>
          <input id="q" name="q" type="search" defaultValue={query} placeholder="form, gloss or provenance" />
          <button type="submit">Apply</button>
        </form>
      </div>

      {all.length === 0 ? (
        <div className="state">
          <h2>This corpus is empty</h2>
          <p>
            The engine ran and found no tokens, so there is nothing to segment. Add tokens to
            corpus/demo/corpus.json and re-run glosslab analyze.
          </p>
        </div>
      ) : (
        <div className="split">
          <section className="panel" aria-label="tokens">
            <div className="panel-head">
              <span className="eyebrow">
                {rows.length} of {all.length}
              </span>
              {query !== '' && (
                <Link className="badge" href="/">
                  clear “{query}”
                </Link>
              )}
            </div>
            <div className="panel-body">
              {rows.length === 0 ? (
                <div className="state">
                  <h2>Nothing matches “{query}”</h2>
                  <p>The filter is a substring match over form, gloss and provenance.</p>
                  <Link className="button" href="/">
                    show every token
                  </Link>
                </div>
              ) : (
                <table className="token-table">
                  <caption className="faint">select a token to see its morpheme tree</caption>
                  <thead>
                    <tr>
                      <th scope="col">token</th>
                      <th scope="col">gloss</th>
                      <th scope="col">state</th>
                      <th scope="col">score</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((token) => {
                      const dispute = disputeOf(token)
                      const active = selected !== null && token.id === selected.id
                      const href =
                        query === ''
                          ? `/?token=${token.id}`
                          : `/?q=${encodeURIComponent(query)}&token=${token.id}`
                      return (
                        <tr key={token.id}>
                          <td className="form">
                            <Link
                              className="token-row-link"
                              href={href}
                              aria-current={active ? 'true' : undefined}
                            >
                              {token.form}
                            </Link>
                          </td>
                          <td className="muted">{token.gloss}</td>
                          <td>
                            {dispute === null ? (
                              <span className="badge" data-tone="ok">
                                ok
                              </span>
                            ) : (
                              <span className="badge" data-tone={TONE[dispute] ?? 'accent'}>
                                {LABEL[dispute] ?? dispute}
                              </span>
                            )}
                          </td>
                          <td className="score">{token.ok ? token.score.toFixed(2) : '—'}</td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              )}
            </div>
          </section>

          <section className="panel" aria-label="morpheme tree">
            <div className="panel-head">
              <span className="eyebrow">morpheme tree</span>
              {selected !== null && disputeOf(selected) !== null && (
                <span className="badge" data-tone="accent">
                  needs review
                </span>
              )}
            </div>
            <div className="panel-body">
              {selected === null ? (
                <div className="state">
                  <h2>No token selected</h2>
                  <p>Pick a form from the list to see how the engine read it.</p>
                </div>
              ) : (
                <Detail token={selected} />
              )}
            </div>
          </section>
        </div>
      )}

      <p className="faint" style={{ marginTop: '1rem' }}>
        {formatPercent(all.length === 0 ? 0 : disputedCount / all.length)} of this corpus needs a human
        decision. <Link href="/plan">see the review plan</Link>.
      </p>
    </>
  )
}
