import { disputeOf, findAnalysisPath, loadAnalysis } from './analysis'
import { PRODUCT, resolveCommit, resolveVersion, SURFACES } from './product'

/**
 * Health from real probes. Every value here is measured on the request; nothing is hard-coded
 * to look healthy. A deployment with no artifact reports `ok: false` rather than pretending.
 *
 * This lives in `lib/` rather than in the route file because a Next.js route module may only
 * export HTTP handlers — and because the health page and the JSON endpoint must never be able
 * to drift apart.
 */

export interface HealthCheck {
  readonly name: string
  readonly status: 'ok' | 'warn' | 'fail'
  readonly detail: string
}

export interface HealthReport {
  readonly ok: boolean
  readonly product: string
  readonly version: string
  readonly commit: string
  readonly language: string | null
  readonly corpusHash: string | null
  readonly tokens: number | null
  readonly reviewNodes: number | null
  readonly disputed: number | null
  readonly planVerified: boolean | null
  readonly artifactPath: string | null
  readonly surfaces: { readonly shipped: number; readonly omitted: number }
  readonly checks: readonly HealthCheck[]
  readonly uptimeSeconds: number
}

export function runProbes(): HealthReport {
  const checks: HealthCheck[] = []
  const commit = resolveCommit()

  checks.push({
    name: 'runtime',
    status: Number(process.versions.node.split('.')[0]) >= 22 ? 'ok' : 'fail',
    detail: `node ${process.versions.node}`,
  })

  // No git on Vercel: an honest "unknown" rather than a fabricated hash.
  checks.push({
    name: 'commit',
    status: commit === 'unknown' ? 'warn' : 'ok',
    detail: commit,
  })

  const artifactPath = findAnalysisPath()
  let tokens: number | null = null
  let reviewNodes: number | null = null
  let disputed: number | null = null
  let planVerified: boolean | null = null
  let language: string | null = null
  let corpusHash: string | null = null

  if (artifactPath === null) {
    checks.push({
      name: 'corpus artifact',
      status: 'fail',
      detail: 'no analysis.json found — run "glosslab analyze --write"',
    })
  } else {
    checks.push({ name: 'corpus artifact', status: 'ok', detail: artifactPath })
    try {
      const analysis = loadAnalysis()
      tokens = analysis.tokens.length
      reviewNodes = analysis.reviewNodes.length
      disputed = analysis.tokens.filter((token) => disputeOf(token) !== null).length
      planVerified = analysis.plan.certificate.verified
      language = analysis.language
      corpusHash = analysis.corpusHash
      checks.push({
        name: 'certificate',
        status: analysis.plan.certificate.verified ? 'ok' : 'fail',
        detail: analysis.plan.certificate.verified
          ? 'the committed plan re-verifies with no violations'
          : `${analysis.plan.certificate.violations.length} violation(s) in the committed plan`,
      })
    } catch (cause) {
      checks.push({
        name: 'corpus artifact',
        status: 'fail',
        detail: cause instanceof Error ? cause.message : String(cause),
      })
    }
  }

  const shipped = SURFACES.filter((surface) => surface.status === 'shipped').length
  const omitted = SURFACES.filter((surface) => surface.status === 'omitted').length
  checks.push({
    name: 'surfaces',
    status: 'ok',
    detail: `${shipped} shipped, ${omitted} deliberately omitted`,
  })

  return {
    ok: checks.every((check) => check.status !== 'fail'),
    product: PRODUCT.slug,
    version: resolveVersion(),
    commit,
    language,
    corpusHash,
    tokens,
    reviewNodes,
    disputed,
    planVerified,
    artifactPath,
    surfaces: { shipped, omitted },
    checks,
    uptimeSeconds: Math.round(process.uptime()),
  }
}
