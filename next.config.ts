import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["sharp"],
  experimental: {
    serverActions: {
      bodySizeLimit: "6mb",
      allowedOrigins: ["localhost:3000", "*.trycloudflare.com"],
    },
  },
  images: {
    unoptimized: true,
  },
};

export default nextConfig;
