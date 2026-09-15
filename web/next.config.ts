import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  allowedDevOrigins: ["192.168.110.27", "*.local"],
  async rewrites() {
    const mainUrl = process.env.MAIN_BACKEND_URL || 'http://localhost:1111';
    const kbUrl = process.env.KB_API_URL || 'http://localhost:8000';
    return [
      // NestJS backend API
      { source: '/api/:path*', destination: `${mainUrl}/api/:path*` },
      // Socket.IO (default path)
      { source: '/socket.io/:path*', destination: `${mainUrl}/socket.io/:path*` },
      // KB direct access (TUS upload, file download)
      { source: '/kb-api/:path*', destination: `${kbUrl}/:path*` },
    ];
  },
};

export default nextConfig;
