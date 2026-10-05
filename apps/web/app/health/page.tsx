import type { Metadata } from 'next'
import { runProbes, type HealthCheck } from '../../lib/health'

export const metadata: Metadata = { title: 'Health' }
export const dynamic = 'force-dynamic'

const TONE: Record<HealthCheck['status'], 'ok' | 'warn' | 'danger'> = {
  ok: 'ok',
  warn: 'warn',
  fail: 'danger',
}

/**
 * The same probes the JSON endpoint runs, rendered. Deliberately the same function: a health
 * page that disagrees with `/api/health` is worse than no health page.
 */
export default function HealthPage() {
  const report = runProbes()

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Health</h1>
          <p>
            Live probes against this deployment. The same values{' '}
            <a href="/api/health">
              <code>/api/health</code>
            </a>{' '}
            returns as JSON, including the corpus hash and whether the committed review plan still
            re-verifies.
          </p>
        </div>
        <span className="badge" data-tone={report.ok ? 'ok' : 'danger'}>
          {report.ok ? 'all probes passed' : 'one or more probes failed'}
        </span>
      </div>

      <section className="panel">
        <div className="panel-head">
          <span className="eyebrow">probes</span>
          <span className="faint">uptime {report.uptimeSeconds}s</span>
        </div>
        <div className="panel-body">
          <table className="plan-table">
            <thead>
              <tr>
                <th scope="col">probe</th>
                <th scope="col">status</th>
                <th scope="col">detail</th>
              </tr>
            </thead>
            <tbody>
              {report.checks.map((check) => (
                <tr key={check.name}>
                  <td>{check.name}</td>
                  <td>
                    <span className="badge" data-tone={TONE[check.status]}>
                      {check.status}
                    </span>
                  </td>
                  <td style={{ whiteSpace: 'normal' }}>{check.detail}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="panel" style={{ marginTop: '1rem' }}>
        <div className="panel-head">
          <span className="eyebrow">what was measured</span>
        </div>
        <div className="panel-body">
          <dl className="certificate">
            <div>
              <dt>version</dt>
              <dd>{report.version}</dd>
            </div>
            <div>
              <dt>commit</dt>
              <dd style={{ fontSize: 'var(--text-sm)' }}>{report.commit}</dd>
            </div>
            <div>
              <dt>language</dt>
              <dd style={{ fontSize: 'var(--text-sm)' }}>{report.language ?? '—'}</dd>
            </div>
            <div>
              <dt>tokens</dt>
              <dd>{report.tokens ?? '—'}</dd>
            </div>
            <div>
              <dt>disputed</dt>
              <dd>{report.disputed ?? '—'}</dd>
            </div>
            <div>
              <dt>plan</dt>
              <dd style={{ fontSize: 'var(--text-sm)' }}>
                {report.planVerified === null ? '—' : report.planVerified ? 'verified' : 'violations'}
              </dd>
            </div>
            <div>
              <dt>surfaces</dt>
              <dd style={{ fontSize: 'var(--text-sm)' }}>{report.surfaces.shipped} shipped</dd>
            </div>
            <div>
              <dt>omitted</dt>
              <dd style={{ fontSize: 'var(--text-sm)' }}>{report.surfaces.omitted}</dd>
            </div>
          </dl>
        </div>
      </section>
    </>
  )
}
