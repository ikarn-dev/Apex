import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,

  // three.js is the largest thing this app ships.
  experimental: {
    optimizePackageImports: ["three"],
  },

  async headers() {
    return [
      {
        source: "/models/:path*",
        headers: [
          {
            // Safe to call immutable, because the URLs really are content
            // addressed now: `game/config/assets.ts` appends a `?v=<hash>` from a
            // manifest the asset pipeline generates, so a rebuilt model is a new
            // cache key.
            //
            // This header previously claimed immutability that the filenames did
            // not provide. An early build shipped Draco-compressed geometry, the
            // loader later dropped its Draco decoder, and browsers went on serving
            // the old bytes from disk for a year — a car that was correct on disk
            // failed to load and neither rebuilding nor reloading could fix it.
            key: "Cache-Control",
            value: "public, max-age=31536000, immutable",
          },
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
