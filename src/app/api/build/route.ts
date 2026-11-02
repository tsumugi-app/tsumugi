import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/** 今配信しているビルド（commit）。開きっぱなしのタブが古いコードのまま動いていないかを確かめるためだけに使う。記録の内容には触れない。 */
export function GET() {
  return NextResponse.json({ build: process.env.VERCEL_GIT_COMMIT_SHA ?? "dev" }, { headers: { "Cache-Control": "no-store" } });
}
