import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // `pnpm dev:lan` 对局域网 IP 提供页面时，允许手机请求 Next 的开发资源。
  allowedDevOrigins: ["192.168.31.120"],
};

export default nextConfig;
