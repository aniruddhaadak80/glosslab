'use client'

/**
 * The error state is a real state, not a placeholder: it names the failure, keeps the stack
 * out of the page, and offers the one action that can help.
 */
export default function Error({ error, reset }: { error: Error; reset: () => void }) {
  return (
    <section>
      <div className="page-head">
        <div>
          <h1>Something went wrong</h1>
          <p>
            This page could not be rendered. If the corpus artifact is missing or malformed, the fix is to
            regenerate it with <code>glosslab analyze --write</code>.
          </p>
        </div>
      </div>
      <div className="state" data-kind="error">
        <h2>Render failed</h2>
        <p className="mono">{error.message}</p>
      </div>
      <p style={{ marginTop: '1rem' }}>
        <button type="button" onClick={reset}>
          Try again
        </button>
      </p>
    </section>
  )
}
