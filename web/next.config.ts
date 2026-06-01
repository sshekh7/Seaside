import type { NextConfig } from "next"

const nextConfig: NextConfig = {
  outputFileTracingIncludes: {
    "/api/experiments/plans": ["./experiments/output/plans-bundle.json"],
  },
}

export default nextConfig
