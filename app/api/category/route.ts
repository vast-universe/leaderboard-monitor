import { NextResponse } from "next/server";

/**
 * Resolve a historical BTC 5m slug to predict.fun's market id.
 * Binance's historical `marketId` belongs to a different id space, so the
 * predict category endpoint is the stable bridge for archived rounds.
 */
export async function GET(request: Request) {
  const apiKey = process.env.PREDICT_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ message: "缺少 PREDICT_API_KEY" }, { status: 500 });
  }

  const slug = new URL(request.url).searchParams.get("slug") ?? "";
  if (!/^btc-updown-5m-\d+$/.test(slug)) {
    return NextResponse.json({ message: "无效的 BTC 5m 轮次" }, { status: 400 });
  }

  try {
    const upstream = await fetch(`https://api.predict.fun/v1/categories/${encodeURIComponent(slug)}`, {
      headers: {
        "x-api-key": apiKey,
        accept: "application/json",
        "user-agent": "leaderboard-monitor/1.0",
      },
      cache: "no-store",
    });
    return new NextResponse(upstream.body, {
      status: upstream.status,
      headers: { "content-type": upstream.headers.get("content-type") ?? "application/json" },
    });
  } catch (error) {
    return NextResponse.json({ message: error instanceof Error ? error.message : "请求失败" }, { status: 502 });
  }
}
