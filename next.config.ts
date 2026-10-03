import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Recovery背景検査の「アプリバージョン」。デプロイ（commit）ごとに1回だけ再検査する。
  env: { NEXT_PUBLIC_APP_BUILD: process.env.VERCEL_GIT_COMMIT_SHA ?? "dev" },
};

export default nextConfig;
