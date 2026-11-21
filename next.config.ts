import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["sharp"],
  experimental: {
    serverActions: {
      bodySizeLimit: "6mb",
    },
  },
  images: {
    unoptimized: true,
  },
};

export default nextConfig;
