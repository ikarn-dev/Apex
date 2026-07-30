import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,

  // The engine chunk is large by nature (three.js + pixi.js). Keep the rest lean.
  experimental: {
    optimizePackageImports: ["three", "pixi.js"],
  },

  // GLB/KTX2 assets are immutable and content-addressed by the build pipeline.
  async headers() {
    return [
      {
        source: "/models/:path*",
        headers: [
          { key: "Cache-Control", value: "public, max-age=31536000, immutable" },
        ],
      },
      {
        source: "/audio/:path*",
        headers: [
          { key: "Cache-Control", value: "public, max-age=31536000, immutable" },
        ],
      },
    ];
  },

  // Next.js 16 builds with Turbopack by default, which shims browser-unavailable
  // node builtins (fs/net/tls/crypto) for web3.js/anchor on its own, so the old
  // webpack `resolve.fallback` block is no longer needed.
  turbopack: {},
};

export default nextConfig;
