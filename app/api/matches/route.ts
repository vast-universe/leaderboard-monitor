import { NextResponse } from "next/server";

export async function GET(request: Request) {
  const apiKey = process.env.PREDICT_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ message: "缺少 PREDICT_API_KEY" }, { status: 500 });
  }
  const url = new URL("https://api.predict.fun/v1/orders/matches");
  url.search = new URL(request.url).search;
  try {
    const upstream = await fetch(url, {
      headers: { "x-api-key": apiKey, accept: "application/json" },
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
