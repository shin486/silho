import type { NextConfig } from "next";

function parseHost(raw?: string): string | null {
  if (!raw) return null;
  try {
    return new URL(raw).host;
  } catch {
    return null;
  }
}

const allowedOrigins = Array.from(
  new Set(
    [
      "localhost:3000",
      "*.trycloudflare.com",
      "*.vercel.app",
      parseHost(process.env.BETTER_AUTH_URL),
      parseHost(process.env.NEXT_PUBLIC_APP_URL),
    ].filter((host): host is string => Boolean(host))
  )
);

const nextConfig: NextConfig = {
  serverExternalPackages: ["sharp"],
  experimental: {
    serverActions: {
      bodySizeLimit: "6mb",
      allowedOrigins,
    },
  },
  images: {
    unoptimized: true,
  },
};

export default nextConfig;
