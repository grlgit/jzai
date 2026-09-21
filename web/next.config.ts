import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  allowedDevOrigins: ["192.168.110.27", "*.local"],
  async headers() {
    return [
      {
        // HTML 文档不缓存：静态预渲染页面默认带 s-maxage=31536000，
        // 手机/代理缓存旧 HTML 会导致新功能（如移动模式）长期不生效
        source: "/((?!_next/static|_next/image|favicon|icon.png|apple-icon.png).*)",
        headers: [
          { key: "Cache-Control", value: "public, max-age=0, must-revalidate" },
        ],
      },
    ];
  },
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
