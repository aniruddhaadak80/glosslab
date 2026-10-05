export default function Loading() {
  return (
    <section aria-busy="true" aria-live="polite">
      <div className="page-head">
        <div>
          <div className="skeleton" style={{ width: '9rem', height: '1.25rem' }} />
          <div className="skeleton" style={{ width: '22rem', marginTop: '0.5rem' }} />
        </div>
      </div>
      <div className="split">
        <div className="panel">
          <div className="panel-head">
            <div className="skeleton" style={{ width: '6rem' }} />
          </div>
          <div className="panel-body">
            {[0, 1, 2, 3, 4].map((row) => (
              <div key={row} className="skeleton" style={{ width: '100%', marginBottom: '0.5rem' }} />
            ))}
          </div>
        </div>
        <div className="panel">
          <div className="panel-head">
            <div className="skeleton" style={{ width: '8rem' }} />
          </div>
          <div className="panel-body">
            <div className="skeleton" style={{ width: '100%', height: '4rem' }} />
          </div>
        </div>
      </div>
      <p className="faint" style={{ marginTop: '1rem' }}>
        loading the corpus analysis…
      </p>
    </section>
  )
}
