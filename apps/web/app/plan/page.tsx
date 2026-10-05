import Link from 'next/link'
import { AnalysisUnavailable, dayLoads, formatMinute, formatPercent, loadAnalysis } from '../../lib/analysis'

/**
 * The review plan and its certificate.
 *
 * The certificate is the point of this page: a schedule you can hand to three linguists is
 * only useful if someone can check it. The bars show each day's load against its capacity so
 * an oversubscribed window could not be missed, and the verdict line is the verifier's own.
 */

export const dynamic = 'force-static'

export default async function PlanPage() {
  let analysis
  try {
    analysis = loadAnalysis()
  } catch (cause) {
    if (cause instanceof AnalysisUnavailable) {
      return (
        <div className="state" data-kind="error">
          <h2>No corpus artifact</h2>
          <p className="mono">{cause.message}</p>
        </div>
      )
    }
    throw cause
  }

  const plan = analysis.plan
  const certificate = plan.certificate
  const loads = dayLoads(plan)
  const nodeById = new Map(analysis.reviewNodes.map((node) => [node.id, node]))

  if (analysis.reviewNodes.length === 0) {
    return (
      <>
        <div className="page-head">
          <div>
            <h1>Review plan</h1>
            <p>The engine found no disputed nodes in this corpus.</p>
          </div>
        </div>
        <div className="state">
          <h2>Nothing to review</h2>
          <p>
            Every token has exactly one reading, its features agree, and no word is ambiguous within the
            declared margin. Widen <code>ambiguityMargin</code> in the grammar to surface more disputes.
          </p>
          <Link className="button" href="/">
            back to the corpus
          </Link>
        </div>
      </>
    )
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Review plan</h1>
          <p>
            {plan.assignments.length} of {analysis.reviewNodes.length} disputes assigned across{' '}
            {new Set(plan.assignments.map((assignment) => assignment.reviewerId)).size} reviewers.
            {plan.unscheduled.length > 0 && ` ${plan.unscheduled.length} could not be placed.`}
          </p>
        </div>
        <span className="badge" data-tone={certificate.verified ? 'ok' : 'danger'}>
          {certificate.verified
            ? 'verified — no window is oversubscribed'
            : `not verified — ${certificate.violations.length} violation(s)`}
        </span>
      </div>

      <section className="panel">
        <div className="panel-head">
          <span className="eyebrow">certificate</span>
          <span className="faint">
            re-derived by verify_plan, a second implementation that never sees the scheduler
          </span>
        </div>
        <div className="panel-body">
          <dl className="certificate">
            <div>
              <dt>effort placed</dt>
              <dd>{certificate.scheduledMinutes}m</dd>
            </div>
            <div>
              <dt>effort raised</dt>
              <dd>{certificate.totalEffortMinutes}m</dd>
            </div>
            <div>
              <dt>capacity</dt>
              <dd>{certificate.windowMinutes}m</dd>
            </div>
            <div>
              <dt>used</dt>
              <dd>{formatPercent(certificate.utilisation)}</dd>
            </div>
            <div>
              <dt>deferred</dt>
              <dd>{certificate.unscheduledCount}</dd>
            </div>
            <div>
              <dt>peak day</dt>
              <dd>
                {certificate.peakDay === null
                  ? '—'
                  : `${certificate.peakDayLoadMinutes}/${certificate.peakDayCapacity}m`}
              </dd>
            </div>
          </dl>

          <div className="load" style={{ marginTop: '1.5rem' }}>
            {loads.map((entry) => (
              <div className="load-row" key={entry.day}>
                <span>{entry.day}</span>
                <span className="load-track">
                  <span
                    className="load-fill"
                    data-hot={entry.utilisation > 0.5}
                    style={{
                      width: `${Math.min(Math.round(entry.utilisation * 100), 100)}%`,
                      display: 'block',
                    }}
                  />
                </span>
                <span className="load-value">
                  {entry.loadMinutes}/{entry.capacityMinutes}m
                </span>
              </div>
            ))}
          </div>

          {certificate.violations.length > 0 && (
            <div className="notice" data-tone="danger" style={{ marginTop: '1rem' }}>
              <strong>The verifier disagrees with this plan.</strong>
              <ul>
                {certificate.violations.map((violation, index) => (
                  <li key={index} className="mono">
                    {violation.code}: {violation.detail}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </section>

      <section className="panel" style={{ marginTop: '1rem' }}>
        <div className="panel-head">
          <span className="eyebrow">assignments</span>
          <span className="faint">earliest deadline first, then priority</span>
        </div>
        <div className="panel-body">
          <table className="plan-table">
            <thead>
              <tr>
                <th scope="col">day</th>
                <th scope="col">slot</th>
                <th scope="col">reviewer</th>
                <th scope="col">dispute</th>
                <th scope="col">kind</th>
                <th scope="col">cost</th>
              </tr>
            </thead>
            <tbody>
              {plan.assignments.map((assignment) => {
                const node = nodeById.get(assignment.nodeId)
                return (
                  <tr key={assignment.nodeId}>
                    <td>{assignment.day}</td>
                    <td>
                      {formatMinute(assignment.startMinute)}–{formatMinute(assignment.endMinute)}
                    </td>
                    <td>{assignment.reviewerId}</td>
                    <td>{node?.token ?? assignment.nodeId}</td>
                    <td>
                      {node === undefined ? (
                        '—'
                      ) : (
                        <span className="badge" data-tone={TONE_BY_KIND[node.kind] ?? 'accent'}>
                          {node.kind}
                        </span>
                      )}
                    </td>
                    <td>{assignment.minutes}m</td>
                  </tr>
                )
              })}
            </tbody>
          </table>

          {plan.unscheduled.length > 0 && (
            <div className="notice" data-tone="warn" style={{ marginTop: '1rem' }}>
              <strong>Not placed.</strong> {plan.unscheduled.join(', ')} — the remaining windows had no
              capacity before the deadline.
            </div>
          )}
        </div>
      </section>

      <section className="panel" style={{ marginTop: '1rem' }}>
        <div className="panel-head">
          <span className="eyebrow">why each dispute exists</span>
        </div>
        <div className="panel-body">
          <table className="plan-table">
            <thead>
              <tr>
                <th scope="col">node</th>
                <th scope="col">kind</th>
                <th scope="col">detail</th>
                <th scope="col">priority</th>
                <th scope="col">skill</th>
              </tr>
            </thead>
            <tbody>
              {analysis.reviewNodes.map((node) => (
                <tr key={node.id}>
                  <td>{node.token}</td>
                  <td>
                    <span className="badge" data-tone={TONE_BY_KIND[node.kind] ?? 'accent'}>
                      {node.kind}
                    </span>
                  </td>
                  <td>{node.detail}</td>
                  <td>{node.priority}</td>
                  <td>{node.requiredSkill ?? 'any'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  )
}

const TONE_BY_KIND: Record<string, 'ok' | 'warn' | 'danger' | 'accent'> = {
  unsegmentable: 'danger',
  feature_conflict: 'danger',
  ambiguous: 'accent',
  gap: 'warn',
}
