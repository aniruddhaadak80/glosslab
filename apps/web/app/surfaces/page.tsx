import Link from 'next/link'
import { SURFACES } from '../../lib/product'

export const dynamic = 'force-static'

/** What this repository ships, and — deliberately — what it does not. */
export default function SurfacesPage() {
  const shipped = SURFACES.filter((surface) => surface.status === 'shipped')
  const omitted = SURFACES.filter((surface) => surface.status === 'omitted')

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Surfaces</h1>
          <p>
            Every capability is a tool in one registry, reachable identically from the CLI, the terminal UI,
            the web app and the MCP server. A surface is either working or listed here as omitted with a
            reason.
          </p>
        </div>
      </div>

      <section className="panel">
        <div className="panel-head">
          <span className="eyebrow">shipped ({shipped.length})</span>
        </div>
        <div className="panel-body">
          <dl className="morph-grid">
            {shipped.map((surface) => (
              <div className="morph" key={surface.id} data-disputed="false">
                <dt>{surface.title}</dt>
                <dd className="muted">{surface.summary}</dd>
              </div>
            ))}
          </dl>
        </div>
      </section>

      <section className="panel" style={{ marginTop: '1rem' }}>
        <div className="panel-head">
          <span className="eyebrow">deliberately omitted ({omitted.length})</span>
        </div>
        <div className="panel-body">
          <dl className="morph-grid">
            {omitted.map((surface) => (
              <div className="morph" key={surface.id} data-disputed="true">
                <dt>{surface.title}</dt>
                <dd className="muted">{surface.summary}</dd>
                <dd className="faint">{surface.reason}</dd>
              </div>
            ))}
          </dl>
        </div>
      </section>

      <p className="faint" style={{ marginTop: '1rem' }}>
        Live status: <Link href="/health">health</Link>.
      </p>
    </>
  )
}
