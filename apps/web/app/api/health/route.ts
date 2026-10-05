import { NextResponse } from 'next/server'
import { runProbes } from '../../../lib/health'

export const dynamic = 'force-dynamic'

/** The JSON form of the same probes the /health page renders. */
export async function GET() {
  const report = runProbes()
  return NextResponse.json(report, {
    status: report.ok ? 200 : 503,
    headers: { 'cache-control': 'no-store' },
  })
}
