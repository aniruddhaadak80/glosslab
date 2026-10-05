/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  eslint: { ignoreDuringBuilds: true },
  typescript: { ignoreBuildErrors: false },

  // The corpus artifact is read at runtime with fs, not imported, so Next's file tracing does
  // not discover it by itself — and an untraced file is not in the deployment bundle. Without
  // this the deployed page renders its "no corpus artifact" state while the repository works
  // perfectly, which is exactly the kind of failure that is invisible until production.
  outputFileTracingIncludes: {
    '/**': ['./data/**'],
  },
}

export default nextConfig
