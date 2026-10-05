import type { Metadata } from 'next'
import Link from 'next/link'
import { PRODUCT } from '../lib/product'
import './globals.css'

export const metadata: Metadata = {
  title: `${PRODUCT.name} — ${PRODUCT.tagline}`,
  description: PRODUCT.oneLiner,
}

const NAV = [
  { href: '/', label: 'corpus' },
  { href: '/plan', label: 'review plan' },
  { href: '/surfaces', label: 'surfaces' },
  { href: '/health', label: 'health' },
] as const

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <div className="shell">
          <a className="skip-link" href="#main">
            skip to content
          </a>
          <header className="site-header">
            <div className="container">
              <Link className="brand" href="/">
                {PRODUCT.name}
                <small>morphology review harness</small>
              </Link>
              <nav className="site-nav" aria-label="primary">
                {NAV.map((item) => (
                  <Link key={item.href} href={item.href}>
                    {item.label}
                  </Link>
                ))}
              </nav>
            </div>
          </header>
          <main id="main">
            <div className="container">{children}</div>
          </main>
          <footer className="site-footer">
            <div className="container">
              <span>
                {PRODUCT.name} {PRODUCT.version} — corpus data is a <strong>constructed demo language</strong>
                , not documentation of a real variety.
              </span>
              <span>deterministic engine: Python, over stdin/stdout</span>
            </div>
          </footer>
        </div>
      </body>
    </html>
  )
}
