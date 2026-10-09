import { NextResponse } from "next/server";

const upstreamUrl = "https://www.binance.com/bapi/defi/v1/public/wallet-direct/prediction/pf/address/positions";

export async function POST(request: Request) {
  try {
    const upstream = await fetch(upstreamUrl, {
      method: "POST",
      headers: { "content-type": "application/json", clienttype: "web", lang: "zh-CN" },
      body: JSON.stringify(await request.json()),
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
