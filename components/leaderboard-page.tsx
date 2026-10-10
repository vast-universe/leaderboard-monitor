"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Activity, CircleAlert, RefreshCw, Wifi, WifiOff } from "lucide-react";
import { Badge, Button, Metric, Panel } from "@/components/ui";
import { PageTitle } from "@/components/page-title";
import { time } from "@/lib/format";

/**
 * 目标账户的持仓监控 + 实时盘口。
 *
 * 为什么是「REST 拿他的数据 + WS 拿盘口」，而不是纯 WS
 * ==================================================
 * 公开 WS **没有任何"按地址推持仓"的主题**（`predictWalletEvents/{jwt}` 只服务
 * 自己的账户，topic 串里还要带钱包 JWT）。**所以要看他的数据就必须走 REST。**
 *
 * 两条链路的跨域情况（都实测过，不是照文档猜的）：
 *   · Binance 持仓接口 → `access-control-allow-origin: *`，**全开**；
 *     浏览器的 POST 预检（带 content-type/clienttype/lang）也放行。
 *   · predict.fun → 只对**精确匹配的 Origin** 回 allow-origin，换个端口就不放行
 *     （实测 3080 拿不到 CORS 头）。所以盘口不走它的 REST，走**它的公开 WS**：
 *     `wss://ws.predict.fun/ws` **完全公开、不需要 x-api-key**
 *     —— 浏览器的 `new WebSocket()` 本来也不能带自定义 header，正好。
 *
 * 心跳：服务端每 15 秒推 `{type:"M",topic:"heartbeat",data:<ts>}`，客户端必须把
 * **同一个时间戳**原样回显 `{method:"heartbeat",data:<ts>}`，否则下个周期被断开。
 *
 * 新项目通过 Next Route Handler 代理需要 API Key 的 REST 请求；浏览器只直连公开 WS。
 */

const WALLET_ADDRESS = "0x6da6cb464f92ae7ad4ec3d239c81719cb1d0ae03";
const PREDICT_BASE = "https://api.predict.fun";
const POSITIONS_URL = "/api/positions";
const WS_URL = "wss://ws.predict.fun/ws";
/** 他的逐笔成交。`first` 上限 150。 */
const MATCHES_URL = "/api/matches";
const MATCHES_LIMIT = 150;
/** 翻几页。150 条里混着 15m / ETH / BNB，只留 BTC 5m 后剩得不多。 */
const MATCHES_PAGES = 3;
/** 查询单局完整成交时的分页保护上限。 */
const FULL_MATCHES_PAGES = 50;
/** 成交刷新间隔。150 条覆盖他约 2~3 分钟的活动，5 秒足够不漏。 */
const MATCHES_INTERVAL_MS = 5_000;
/**
 * 历史真实表现用 Binance 的**已结算持仓**接口 —— 它的 `pnl` / `avgPrice`
 * 是**直出的真实值**，不是从成交流重建的。
 *
 * ⚠️ 数值口径与 predict.fun 不同：这里全是**普通小数**
 *   （`shares: 0.0`、`avgPrice: 0.5899`、`totalBoughtShares: 4863.88`），
 *   而 predict.fun 的 `amount` 是 1e18 定点。两者不能混用同一个除法。
 */
const BINANCE_CLOSED_URL = "/api/history";
/** 拉多少页历史（每页 20 条，一局两条腿 ⇒ 约 10 局/页）。 */
const HISTORY_PAGES = 25;
const HISTORY_TYPE = "closed";
/** 只看这个周期（Binance 侧的 slug）。 */
const HISTORY_SLUG = "btc-up-or-down-5m";

/**
 * 持仓的刷新策略：**事件驱动 + 兜底轮询**。
 *
 * ⚠️ 为什么持仓不能像盘口那样"纯 WS"：公开 WS 里**没有任何"按地址推持仓"的主题**
 *   （`predictWalletEvents/{jwt}` 的 topic 串里要带钱包 JWT，只服务自己的账户）。
 *   ⇒ 他的持仓只能 REST 拉。
 *
 * 但也不必傻等固定间隔 —— **他只有在成交时持仓才会变**，而市场成交我们是能
 * 从 WS 的 `lastOrderSettled` 实时看到的。所以：WS 一收到成交就触发一次拉取
 * （`TRADE_THROTTLE_MS` 节流，避免一秒几十笔时打爆接口），
 * `POSITIONS_INTERVAL_MS` 只作为兜底，防止长时间没成交时数据陈旧。
 */
const POSITIONS_INTERVAL_MS = 20_000;
/** 成交触发的拉取最快多久一次。 */
const TRADE_THROTTLE_MS = 1_500;
/**
 * 只盯 BTC 5 分钟。predict.fun 的 `market.categorySlug` 形如
 * `btc-updown-5m-1790431500`（末尾是开盘 unix 秒）。
 *
 * **它的 `market.id` 正好就是 WS 订阅要的 id** ⇒ 不用再做 Binance↔predict 的映射。
 */
const TARGET_SLUG = "btc-updown-5m";
const MAX_MARKETS = 12;
const MAX_TRADES = 60;
const BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 15_000];
const STALE_MS = 30_000;

/**
 * `market.status === "RESOLVED"` 的腿**不是当前持仓**，必须剔除，否则持仓表会满屏「无」。
 *
 * ⚠️ 已结算的局里，**赢腿被赎回后就从 `/v1/positions` 消失了**（`1 UP + 1 DOWN ≡ $1`，
 *   赎回换钱），只剩输腿残渣 —— 于是配对后看起来像「他缺了一条腿」。
 *   实测他 23 条腿里 10 条是这种：5 局 BTC 5m 全成了单腿，还有一条 `amount` 只剩 0.05 股的尘埃。
 *
 * 反向偏差的完整推导见 `docs/pair-grid.md` §7.3。
 */
const SETTLED_STATUS = "RESOLVED";

/** predict.fun `/v1/positions/{address}` 的一条 = 一个市场的**一条腿**。 */
type PredictPosition = {
  amount?: string | null;
  averageBuyPriceUsd?: string | null;
  pnlUsd?: string | null;
  valueUsd?: string | null;
  outcome?: { name?: string | null } | null;
  market?: {
    id?: number;
    categorySlug?: string | null;
    title?: string | null;
    status?: string | null;
  } | null;
};

type Leg = { shares: number; avg: number; pnl: number; current: number };

/** 逐腿持仓按市场配对后的结果。**结算份额平衡看 `pairedPct`。** */
type Paired = {
  key: string;
  title: string;
  up: Leg | null;
  down: Leg | null;
  matched: number;
  naked: number;
  pairedPct: number;
  pairCost: number | null;
  pnl: number;
  size: number;
  /** 持仓偏重的那条腿；两边相等或都为空时为 null。 */
  heavy: "UP" | "DOWN" | null;
  /** `market.status`；`RESOLVED` 表示已结算（正常情况下已被上游过滤掉）。 */
  status: string;
};

/** Binance 已结算持仓的一条 = 一个市场的一条腿。数值是普通小数。 */
type ClosedPosition = {
  marketTitle?: string;
  eventSlug?: string;
  outcomeName?: string;
  outcomeWinner?: boolean;
  result?: string;
  avgPrice?: number | string | null;
  pnl?: number | string | null;
  settleRoi?: number | string | null;
  totalBoughtShares?: number | string | null;
  totalSoldShares?: number | string | null;
  closeType?: string | null;
  lastActiveTime?: number | string | null;
};

/** `matches` 里他的一条成交（maker 或 taker 侧）。 */
type MatchRow = {
  at: number;
  marketId: number | string;
  slug: string;
  leg: string;
  price: number;
  shares: number;
  side: string;
  role: "MAKER" | "TAKER";
  hash: string;
};

type PairLeg = MatchRow;
type PairSlice = {
  key: string;
  shares: number;
  up: PairLeg;
  down: PairLeg;
};
type PairGroup = {
  key: string;
  slug: string;
  marketId: number | string;
  latestAt: number;
  upShares: number;
  downShares: number;
  pairedShares: number;
  naked: number;
  nakedSide: "UP" | "DOWN" | null;
  pairCost: number | null;
  pairs: PairSlice[];
  residuals: PairLeg[];
};

/** 历史逐局（两腿配对后）。 */
type HistoryRound = {
  key: string;
  title: string;
  predictSlug: string | null;
  up: number;
  down: number;
  upAvg: number;
  downAvg: number;
  matched: number;
  naked: number;
  pairedPct: number;
  pairCost: number | null;
  pnl: number;
  winner: "UP" | "DOWN" | null;
  at: number;
};

type Level = [number, number];

type ReplayPoint = {
  key: string;
  at: number;
  elapsed: number;
  up: number;
  down: number;
  price: number;
  leg: "UP" | "DOWN";
  shares: number;
  role: MatchRow["role"];
};

type BookData = {
  marketId: number;
  asks?: Level[];
  bids?: Level[];
  orderCount?: number;
  lastOrderSettled?: {
    id?: string | number;
    price?: string;
    kind?: string;
    side?: string;
  } | null;
};

type Market = { id: number; categorySlug?: string; title?: string; tradingStatus?: string };

function num(value: number | string | null | undefined): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** 成交数量统一保留两位；配对逻辑保持浏览器兼容，不依赖 BigInt。 */
function formatTradeShares(value: number): string {
  return Number.isFinite(value) ? value.toFixed(2) : "0.00";
}

/**
 * 成交股数不能统一保留 1 位小数：FIFO 拆分后会出现小于 0.05 股的片段，
 * 直接 `toFixed(1)` 会把它显示成 0.0，误导分析。大数保持紧凑，小数保留到足以
 * 看见有效数量的精度。
 */
function formatShares(value: number): string {
  if (!Number.isFinite(value) || Math.abs(value) < 0.0000005) return "0";
  const absolute = Math.abs(value);
  const decimals =
    absolute >= 100 ? 0
      : absolute >= 10 ? 1
        : absolute >= 1 ? 2
          : absolute >= 0.1 ? 3
            : absolute >= 0.01 ? 4
              : absolute >= 0.001 ? 5
                : 6;
  return value.toFixed(decimals).replace(/\.?(0+)$/, "");
}

function which(position: PredictPosition): "up" | "down" | null {
  const name = (position.outcome?.name ?? "").trim().toLowerCase();
  if (name.startsWith("up") || name === "yes") return "up";
  if (name.startsWith("down") || name === "no") return "down";
  return null;
}

/** `amount` 是 1e18 定点。 */
function toLeg(position: PredictPosition): Leg {
  return {
    shares: num(position.amount) / 1e18,
    avg: num(position.averageBuyPriceUsd),
    pnl: num(position.pnlUsd),
    current: 0,
  };
}

/** 逐腿 → 逐市场配对。`pairedPct = 2·min/(up+dn)`，1 表示涨跌赔付完全相同。 */
function pairOf(positions: PredictPosition[]): Paired[] {
  const groups = new Map<string, PredictPosition[]>();
  for (const position of positions) {
    const title = position.market?.categorySlug ?? String(position.market?.id ?? "?");
    const list = groups.get(title) ?? [];
    list.push(position);
    groups.set(title, list);
  }
  const out: Paired[] = [];
  for (const [title, legs] of groups) {
    let up: Leg | null = null;
    let down: Leg | null = null;
    let status = "";
    for (const position of legs) {
      const side = which(position);
      if (side === "up") up = toLeg(position);
      else if (side === "down") down = toLeg(position);
      status = position.market?.status ?? status;
    }
    const upShares = up?.shares ?? 0;
    const downShares = down?.shares ?? 0;
    const biggest = Math.max(upShares, downShares);
    const matched = Math.min(upShares, downShares);
    out.push({
      key: title,
      title,
      up,
      down,
      matched,
      naked: Math.abs(upShares - downShares),
      pairedPct: biggest > 0 ? (2 * matched) / (upShares + downShares) : 0,
      pairCost:
        up && down && up.avg > 0 && down.avg > 0 ? up.avg + down.avg : null,
      pnl: (up?.pnl ?? 0) + (down?.pnl ?? 0),
      size: upShares + downShares,
      heavy:
        upShares === downShares || biggest === 0
          ? null
          : upShares > downShares
            ? "UP"
            : "DOWN",
      status,
    });
  }
  return out.sort((a, b) => b.size - a.size);
}

function targetsOf(rows: PredictPosition[]): Market[] {
    const seen = new Map<number, Market>();
    for (const row of rows) {
      const slug = row.market?.categorySlug ?? "";
      const id = row.market?.id;
      if (typeof id !== "number" || !slug.startsWith(TARGET_SLUG)) continue;
      // 已结算的市场没有盘口可订阅，订了也是白等。
      if (row.market?.status === SETTLED_STATUS) continue;
      if (seen.has(id)) continue;
      seen.set(id, { id, categorySlug: slug, title: row.market?.title ?? slug, tradingStatus: "OPEN" });
    }
    return [...seen.values()].slice(0, MAX_MARKETS);
}

/**
 * 把 `matches` 的一条记录拆成「他这一侧的成交」。
 *
 * ⚠️ 一条 match 里他的身份可能是 **maker**（列表里的一项）或 **taker**（单个对象），
 *   两边的价格字段还不一样：**taker 侧叫 `price`，顶层另有聚合值 `priceExecuted`**。
 *   （我在分析脚本里就因为读了 `taker.priceExecuted` 得到一堆 0 价格，踩过一次。）
 */
function parseMatches(payload: unknown): MatchRow[] {
  const data = (payload as { data?: unknown[] } | null)?.data;
  if (!Array.isArray(data)) return [];
  const out: MatchRow[] = [];
  for (const raw of data) {
    const record = raw as {
      executedAt?: string;
      market?: { id?: number | string; categorySlug?: string | null };
      makers?: {
        amount?: string;
        price?: string;
        signer?: string;
        quoteType?: string;
        hash?: string;
        outcome?: { name?: string | null } | null;
      }[];
      taker?: {
        amount?: string;
        price?: string;
        signer?: string;
        quoteType?: string;
        hash?: string;
        outcome?: { name?: string | null } | null;
      } | null;
    };
    const at = Date.parse(record.executedAt ?? "") || 0;
    for (const side of ["makers", "taker"] as const) {
      const entries = side === "taker" ? [record.taker] : (record.makers ?? []);
      for (const entry of entries) {
        if (!entry) continue;
        if ((entry.signer ?? "").toLowerCase() !== WALLET_ADDRESS.toLowerCase()) continue;
        out.push({
          at,
          marketId: record.market?.id ?? "?",
          slug: record.market?.categorySlug ?? "",
          leg: entry.outcome?.name ?? "?",
          price: num(entry.price) / 1e18,
          shares: num(entry.amount) / 1e18,
          side: entry.quoteType ?? "?",
          role: side === "makers" ? "MAKER" : "TAKER",
          hash: (entry.hash ?? "").slice(2, 10),
        });
      }
    }
  }
  return out.sort((a, b) => b.at - a.at);
}

async function resolvePredictMarketId(slug: string): Promise<number> {
  const query = new URLSearchParams({ slug });
  const response = await fetch(`/api/category?${query.toString()}`, { cache: "no-store" });
  if (!response.ok) throw new Error(`轮次元数据 HTTP ${response.status}`);
  const payload = (await response.json()) as {
    data?: { markets?: { id?: number | string; categorySlug?: string | null }[] | null } | null;
  };
  const market = (payload.data?.markets ?? []).find((row) => row.categorySlug === slug) ?? payload.data?.markets?.[0];
  const marketId = Number(market?.id);
  if (!Number.isInteger(marketId) || marketId <= 0) throw new Error("找不到该历史轮次的 predict 市场");
  return marketId;
}

async function fetchCompleteRoundMatches(slug: string, marketId: number | string): Promise<MatchRow[]> {
  const collected: MatchRow[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | null = null;
  for (let page = 0; page < FULL_MATCHES_PAGES; page += 1) {
    const query = new URLSearchParams({
      signerAddress: WALLET_ADDRESS,
      first: String(MATCHES_LIMIT),
      marketId: String(marketId),
    });
    if (cursor) query.set("after", cursor);
    const response = await fetch(`${MATCHES_URL}?${query.toString()}`, { cache: "no-store" });
    if (!response.ok) throw new Error(`成交接口 HTTP ${response.status}`);
    const payload = (await response.json()) as { cursor?: string };
    collected.push(...parseMatches(payload).filter((row) => row.slug === slug));
    const nextCursor = payload.cursor ?? null;
    if (!nextCursor || seenCursors.has(nextCursor)) break;
    seenCursors.add(nextCursor);
    cursor = nextCursor;
  }
  return collected;
}

/**
 * 逐笔成交只告诉我们各腿的成交，不会告诉我们钱包实际如何把两腿配成一组。
 * 这里用时间先后做 FIFO 配对：新成交先消化另一边最早的未配数量，剩余数量留在队列。
 * 这个结果用于分析展示，不能当作交易所的真实撮合关系。
 */
function pairMatches(rows: MatchRow[]): PairGroup[] {
  const groups = new Map<string, MatchRow[]>();
  for (const row of rows) {
    const list = groups.get(row.slug) ?? [];
    list.push(row);
    groups.set(row.slug, list);
  }
  return [...groups.entries()]
    .map(([slug, rawRows]) => {
      const ordered = [...rawRows].sort((a, b) => a.at - b.at);
      const upQueue: PairLeg[] = [];
      const downQueue: PairLeg[] = [];
      const pairs: PairSlice[] = [];
      const upShares = ordered
        .filter((row) => row.leg.toLowerCase().startsWith("up"))
        .reduce((sum, row) => sum + row.shares, 0);
      const downShares = ordered
        .filter((row) => row.leg.toLowerCase().startsWith("down"))
        .reduce((sum, row) => sum + row.shares, 0);
      for (const row of ordered) {
        let remaining = row.shares;
        const opposite = row.leg.toLowerCase().startsWith("up") ? downQueue : upQueue;
        while (remaining > 1e-8 && opposite.length > 0) {
          const other = opposite[0]!;
          const amount = Math.min(remaining, other.shares);
          const up = row.leg.toLowerCase().startsWith("up")
            ? { ...row, shares: amount }
            : { ...other, shares: amount };
          const down = row.leg.toLowerCase().startsWith("down")
            ? { ...row, shares: amount }
            : { ...other, shares: amount };
          pairs.push({ key: `${row.at}:${row.hash}:${pairs.length}`, shares: amount, up, down });
          remaining -= amount;
          other.shares -= amount;
          if (other.shares <= 1e-8) opposite.shift();
        }
        if (remaining > 1e-8) {
          const queue = row.leg.toLowerCase().startsWith("up") ? upQueue : downQueue;
          queue.push({ ...row, shares: remaining });
        }
      }
      const pairedShares = Math.min(upShares, downShares);
      const pairedCost = pairs.reduce((sum, pair) => sum + pair.shares * (pair.up.price + pair.down.price), 0);
      return {
        key: slug,
        slug,
        marketId: ordered[0]?.marketId ?? "?",
        latestAt: Math.max(...ordered.map((row) => row.at)),
        upShares,
        downShares,
        pairedShares,
        naked: Math.abs(upShares - downShares),
        nakedSide: upShares === downShares ? null : upShares > downShares ? "UP" : "DOWN",
        pairCost: pairedShares > 0 ? pairedCost / pairedShares : null,
        pairs,
        residuals: [...upQueue, ...downQueue],
      } satisfies PairGroup;
    })
    .sort((a, b) => b.latestAt - a.latestAt);
}

function matchMarketLabel(slug: string): string {
  const slot = /-(\d{10})$/.exec(slug)?.[1];
  return slot ? `BTC 5m · ${time(Number(slot) * 1000)}` : slug.replace(/^btc-updown-5m-/, "5m-").slice(0, 20);
}

function predictSlugFromHistoryTime(value: number): string | null {
  const seconds = value > 1e12 ? Math.floor(value / 1000) : Math.floor(value);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return `${TARGET_SLUG}-${Math.floor(seconds / 300) * 300}`;
}

/** 逐腿 → 逐局。`winner` 取 `outcomeWinner` 为真的那条腿。 */
function historyRounds(rows: ClosedPosition[]): HistoryRound[] {
  const groups = new Map<string, ClosedPosition[]>();
  for (const row of rows) {
    if (row.eventSlug !== HISTORY_SLUG) continue;
    const title = row.marketTitle ?? "?";
    const list = groups.get(title) ?? [];
    list.push(row);
    groups.set(title, list);
  }
  const out: HistoryRound[] = [];
  for (const [title, legs] of groups) {
    let up: ClosedPosition | null = null;
    let down: ClosedPosition | null = null;
    for (const leg of legs) {
      const name = (leg.outcomeName ?? "").toLowerCase();
      if (name.startsWith("up")) up = leg;
      else if (name.startsWith("down")) down = leg;
    }
    const upShares = num(up?.totalBoughtShares ?? up?.avgPrice);
    const downShares = num(down?.totalBoughtShares);
    const upBought = upShares;
    const downBought = downShares;
    const upAvg = num(up?.avgPrice);
    const downAvg = num(down?.avgPrice);
    const biggest = Math.max(upBought, downBought);
    const matched = Math.min(upBought, downBought);
    const winner: "UP" | "DOWN" | null = up?.outcomeWinner
      ? "UP"
      : down?.outcomeWinner
        ? "DOWN"
        : null;
    const at = num(up?.lastActiveTime ?? down?.lastActiveTime);
    out.push({
      key: `${title}:${at}`,
      title,
      predictSlug: predictSlugFromHistoryTime(at),
      up: upBought,
      down: downBought,
      upAvg,
      downAvg,
      matched,
      naked: Math.abs(upBought - downBought),
      pairedPct: biggest > 0 ? (2 * matched) / (upBought + downBought) : 0,
      pairCost: upAvg > 0 && downAvg > 0 ? upAvg + downAvg : null,
      pnl: num(up?.pnl) + num(down?.pnl),
      winner,
      at,
    });
  }
  return out.sort((a, b) => b.at - a.at);
}

function shortLabel(market: Market): string {
  const slug = market.categorySlug ?? "";
  const matched = /^([a-z]+)-updown-(\d+)([mh])-/.exec(slug);
  if (matched) return `${matched[1]!.toUpperCase()} ${matched[2]}${matched[3]}`;
  return (market.title ?? slug ?? `#${market.id}`).slice(0, 22);
}

function topOf(levels: Level[] | undefined): Level | null {
  if (!levels || levels.length === 0) return null;
  const [price, size] = levels[0]!;
  return Number.isFinite(price) ? [price, size] : null;
}

/**
 * 单局 5 分钟回放图：三条线分别是 UP 持仓、DOWN 持仓和当前价格。
 * 价格线使用 UP 价格，DOWN 价格按 1-UP 换算，这样只需要一个价格轴。
 */
function RoundReplayChart({ rows, slug }: { rows: MatchRow[]; slug: string }) {
  const [hovered, setHovered] = useState<ReplayPoint | null>(null);
  const points = useMemo<ReplayPoint[]>(() => {
    const ordered = rows.filter((row) => row.slug === slug).sort((a, b) => a.at - b.at);
    if (ordered.length === 0) return [];
    const slotMatch = /-(\d{10})$/.exec(slug);
    const slotStart = slotMatch ? Number(slotMatch[1]) * 1000 : ordered[0]!.at;
    let up = 0;
    let down = 0;
    const first = ordered[0]!;
    const firstLeg = first.leg.toLowerCase().startsWith("up") ? "UP" : "DOWN";
    const firstPrice = Math.max(0, Math.min(1, firstLeg === "UP" ? first.price : 1 - first.price));
    const result: ReplayPoint[] = [{
      key: "start",
      at: slotStart,
      elapsed: 0,
      up: 0,
      down: 0,
      price: firstPrice,
      leg: firstLeg,
      shares: 0,
      role: first.role,
    }];
    for (const row of ordered) {
      const leg = row.leg.toLowerCase().startsWith("up") ? "UP" : "DOWN";
      if (leg === "UP") up += row.shares;
      else down += row.shares;
      result.push({
        key: `${row.at}:${row.hash}:${result.length}`,
        at: row.at,
        elapsed: Math.max(0, Math.min(300, (row.at - slotStart) / 1000)),
        up,
        down,
        price: Math.max(0, Math.min(1, leg === "UP" ? row.price : 1 - row.price)),
        leg,
        shares: row.shares,
        role: row.role,
      });
    }
    return result;
  }, [rows, slug]);

  if (points.length < 2) return null;

  const width = 940;
  const height = 310;
  const left = 52;
  const right = 52;
  const top = 22;
  const bottom = 39;
  const plotWidth = width - left - right;
  const plotHeight = height - top - bottom;
  const maxShares = Math.max(1, ...points.map((point) => Math.max(point.up, point.down)));
  const x = (elapsed: number) => left + (elapsed / 300) * plotWidth;
  const yShares = (value: number) => top + (1 - value / maxShares) * plotHeight;
  const yPrice = (value: number) => top + (1 - value) * plotHeight;
  const upLine = points.map((point) => `${x(point.elapsed).toFixed(2)},${yShares(point.up).toFixed(2)}`).join(" ");
  const downLine = points.map((point) => `${x(point.elapsed).toFixed(2)},${yShares(point.down).toFixed(2)}`).join(" ");
  const priceLine = points.map((point) => `${x(point.elapsed).toFixed(2)},${yPrice(point.price).toFixed(2)}`).join(" ");
  const last = points[points.length - 1]!;
  const ticks = [0, 60, 120, 180, 240, 300];
  const formatElapsed = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;
  const formatPrice = (value: number) => value.toFixed(3);

  return (
    <div className="round-replay" aria-label="单局五分钟持仓和价格回放">
      <div className="round-replay-head">
        <div>
          <strong>5 分钟回放</strong>
          <span className="small">三条线：累计持仓 + 当前价格</span>
        </div>
        <div className="round-replay-legend" aria-label="图例">
          <span><i className="replay-dot up" />UP 持仓</span>
          <span><i className="replay-dot down" />DOWN 持仓</span>
          <span><i className="replay-dot price" />当前价格</span>
        </div>
      </div>
      <div className="round-replay-chart-wrap">
        <svg className="round-replay-chart" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="UP 持仓、DOWN 持仓和当前价格的五分钟变化">
          <g className="replay-grid">
            {[0, 0.25, 0.5, 0.75, 1].map((fraction) => {
              const yPos = top + fraction * plotHeight;
              return <line key={fraction} x1={left} x2={width - right} y1={yPos} y2={yPos} />;
            })}
            {ticks.map((tick) => <line key={tick} x1={x(tick)} x2={x(tick)} y1={top} y2={height - bottom} />)}
          </g>
          <polyline className="replay-line up" points={upLine} />
          <polyline className="replay-line down" points={downLine} />
          <polyline className="replay-line price" points={priceLine} />
          {points.slice(1).map((point) => (
            <g key={point.key} onMouseEnter={() => setHovered(point)} onFocus={() => setHovered(point)} tabIndex={0}>
              <circle className={`replay-event ${point.leg.toLowerCase()}`} cx={x(point.elapsed)} cy={yShares(point.leg === "UP" ? point.up : point.down)} r={2.8} />
              <circle className="replay-price-event" cx={x(point.elapsed)} cy={yPrice(point.price)} r={2.3} />
              <title>{`${formatElapsed(point.elapsed)} · ${point.leg} ${formatShares(point.shares)} 股 · 价格 ${formatPrice(point.price)} · 持仓 ${formatShares(point.up)} / ${formatShares(point.down)}`}</title>
            </g>
          ))}
          <g className="replay-axis-labels">
            <text x={left - 9} y={top + 4} textAnchor="end">{formatShares(maxShares)}</text>
            <text x={left - 9} y={height - bottom + 4} textAnchor="end">0</text>
            <text x={width - right + 9} y={top + 4}>1.00</text>
            <text x={width - right + 9} y={top + plotHeight / 2 + 4}>0.50</text>
            <text x={width - right + 9} y={height - bottom + 4}>0.00</text>
            {ticks.map((tick) => <text key={tick} x={x(tick)} y={height - 10} textAnchor="middle">{formatElapsed(tick)}</text>)}
          </g>
        </svg>
        <span className="replay-axis-title left">持仓（股）</span>
        <span className="replay-axis-title right">价格（UP，DOWN=1-UP）</span>
      </div>
      <div className="round-replay-detail" aria-live="polite">
        {hovered ? (
          <>
            <span className="mono">{formatElapsed(hovered.elapsed)}</span>
            <span className={hovered.leg === "UP" ? "positive" : "negative"}>{hovered.leg} 成交 {formatShares(hovered.shares)} 股</span>
            <span>价格 <b>{formatPrice(hovered.price)}</b></span>
            <span>持仓 <b>{formatShares(hovered.up)} / {formatShares(hovered.down)}</b></span>
            <span>{hovered.role === "MAKER" ? "挂单" : "吃单"}</span>
          </>
        ) : (
          <span>悬停图上的成交点查看该时刻的成交和累计持仓 · 当前价格线按成交价重建</span>
        )}
      </div>
      <div className="round-replay-summary">
        <span>结束持仓 <b>{formatShares(last.up)} / {formatShares(last.down)}</b></span>
        <span>结束价格 <b>{formatPrice(last.price)}</b></span>
        <span>成交点 <b>{points.length - 1}</b></span>
      </div>
    </div>
  );
}

export function LeaderboardPage() {
  // 他的持仓（REST，5 秒）
  const [positions, setPositions] = useState<PredictPosition[]>([]);
  const [positionError, setPositionError] = useState<string | null>(null);
  const [closed, setClosed] = useState<ClosedPosition[]>([]);
  const [historyBusy, setHistoryBusy] = useState(false);
  const [matches, setMatches] = useState<MatchRow[]>([]);
  const [matchView, setMatchView] = useState<"paired" | "raw">("paired");
  const [selectedRound, setSelectedRound] = useState<string | null>(null);
  const [selectedHistoryKey, setSelectedHistoryKey] = useState("");
  const [fullRoundMatches, setFullRoundMatches] = useState<MatchRow[]>([]);
  const [fullRoundBusy, setFullRoundBusy] = useState(false);
  const [fullRoundError, setFullRoundError] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState(0);

  // 实时盘口（WS）
  const [markets, setMarkets] = useState<Market[]>([]);
  const [labels, setLabels] = useState<Record<number, string>>({});
  const [books, setBooks] = useState<Record<number, BookData & { receivedAt: number }>>({});
  const [trades, setTrades] = useState<
    { key: string; at: number; label: string; price: string; kind: string; side: string }[]
  >([]);
  const [status, setStatus] = useState<"CONNECTING" | "OPEN" | "CLOSED">("CLOSED");
  const [wsError, setWsError] = useState<string | null>(null);
  const [clock, setClock] = useState(() => Date.now());

  const busyRef = useRef(false);
  /** 上一次因成交触发的拉取时刻，用于节流。 */
  const lastTradePullRef = useRef(0);
  /** 把最新的 loadPositions 放进 ref，供 WS 回调调用（避免闭包过期）。 */
  const pullRef = useRef<() => void>(() => {});
  const socketRef = useRef<WebSocket | null>(null);
  const retryRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stopRef = useRef(false);
  const requestRef = useRef(1);
  const labelRef = useRef<Map<number, string>>(new Map());
  const connectRef = useRef<(targets: Market[]) => void>(() => {});


  /**
   * WS 要订哪些市场 —— **直接从他持仓里取**，不再单独查市场列表。
   *
   * 好处：`market.id` 和 `categorySlug` 都来自同一条记录，
   * **不存在 Binance↔predict 的 id 映射问题**（那是我之前担心的最大风险点）。
   */

  const loadPositions = useCallback(async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    try {
      const response = await fetch(`${POSITIONS_URL}?first=100`, { cache: "no-store" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = (await response.json()) as {
        success?: boolean;
        message?: string;
        data?: PredictPosition[] | { data?: PredictPosition[] };
      };
      if (payload.success === false) throw new Error(payload.message || "接口返回失败");
      const raw = payload.data;
      const rows = Array.isArray(raw) ? raw : (raw?.data ?? []);
      setPositions(rows);
      // 订阅目标直接从这次的持仓里推出来 —— 省掉一次市场列表请求，
      // 而且 market.id 与 categorySlug 同源，不会有 id 映射问题。
      const targets = targetsOf(rows);
      labelRef.current = new Map(targets.map((m) => [m.id, shortLabel(m)]));
      setLabels(Object.fromEntries(labelRef.current));
      setMarkets((prev) =>
        prev.length === targets.length && prev.every((m, i) => m.id === targets[i]?.id)
          ? prev // 目标没变就别触发重连
          : targets,
      );
      setUpdatedAt(Date.now());
      setPositionError(null);
    } catch (cause) {
      setPositionError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      busyRef.current = false;
    }
  }, []);

  /**
   * 他的逐笔成交 —— **只留 BTC 5m**。
   *
   * `matches` 不按市场过滤，返回的是他所有市场（15m / ETH / BNB）的最近若干笔，
   * 所以这里翻几页再用 `categorySlug` 过滤，否则 BTC 5m 剩不下几笔。
   */
  const loadMatches = useCallback(async () => {
    try {
      const collected: MatchRow[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < MATCHES_PAGES; page += 1) {
        const query = new URLSearchParams({
          signerAddress: WALLET_ADDRESS,
          first: String(MATCHES_LIMIT),
        });
        if (cursor) query.set("after", cursor);
        const response = await fetch(`${MATCHES_URL}?${query.toString()}`, { cache: "no-store" });
        if (!response.ok) break;
        const payload = (await response.json()) as { cursor?: string };
        collected.push(...parseMatches(payload));
        cursor = payload.cursor ?? null;
        if (!cursor) break;
      }
      setMatches(collected.filter((row) => row.slug.startsWith(TARGET_SLUG)));
    } catch {
      // 成交面板是补充信息，失败不影响持仓与盘口。
    }
  }, []);

  /** 按单个市场翻完所有分页，供轮次卡片查看完整成交。 */
  const loadFullRound = useCallback(async (group: PairGroup) => {
    if (fullRoundBusy) return;
    setSelectedRound(group.key);
    setSelectedHistoryKey("");
    setFullRoundBusy(true);
    setFullRoundError(null);
    setFullRoundMatches([]);
    try {
      setFullRoundMatches(await fetchCompleteRoundMatches(group.slug, group.marketId));
    } catch (cause) {
      setFullRoundMatches([]);
      setFullRoundError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setFullRoundBusy(false);
    }
  }, [fullRoundBusy]);

  const loadHistoricalRound = useCallback(async (row: HistoryRound) => {
    if (fullRoundBusy || !row.predictSlug) return;
    setSelectedHistoryKey(row.key);
    setSelectedRound(row.predictSlug);
    setFullRoundBusy(true);
    setFullRoundError(null);
    setFullRoundMatches([]);
    try {
      const marketId = await resolvePredictMarketId(row.predictSlug);
      setFullRoundMatches(await fetchCompleteRoundMatches(row.predictSlug, marketId));
    } catch (cause) {
      setFullRoundMatches([]);
      setFullRoundError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setFullRoundBusy(false);
    }
  }, [fullRoundBusy]);

  /**
   * 拉他的**已结算**持仓（历史真实表现）。
   *
   * 只在挂载时拉一次 —— 历史不会变，没必要轮询。
   * 分页上限是 20 条/页（传更大的值会返回空），所以按页循环。
   */
  const loadHistory = useCallback(async () => {
    setHistoryBusy(true);
    try {
      const collected: ClosedPosition[] = [];
      for (let page = 1; page <= HISTORY_PAGES; page += 1) {
        const response = await fetch(BINANCE_CLOSED_URL, {
          method: "POST",
          headers: { "content-type": "application/json", clienttype: "web", lang: "zh-CN" },
          body: JSON.stringify({
            walletAddress: WALLET_ADDRESS,
            type: HISTORY_TYPE,
            sortBy: "TIME",
            sortOrder: "DESC",
            page,
            pageSize: 20,
          }),
        });
        if (!response.ok) break;
        const payload = (await response.json()) as {
          data?: { entries?: ClosedPosition[] };
        };
        const rows = payload.data?.entries ?? [];
        if (rows.length === 0) break;
        collected.push(...rows);
      }
      setClosed(collected);
    } catch {
      // 历史面板拿不到不影响实时那一块。
    } finally {
      setHistoryBusy(false);
    }
  }, []);

  const connect = useCallback((targets: Market[]) => {
    if (targets.length === 0) return;
    if (timerRef.current) clearTimeout(timerRef.current);
    stopRef.current = false;
    setStatus("CONNECTING");

    let socket: WebSocket;
    try {
      socket = new WebSocket(WS_URL);
    } catch (cause) {
      setStatus("CLOSED");
      setWsError(cause instanceof Error ? cause.message : "无法建立 WebSocket");
      return;
    }
    socketRef.current = socket;

    socket.onopen = () => {
      retryRef.current = 0;
      setStatus("OPEN");
      setWsError(null);
      // 文档：一次请求订阅一个主题。
      for (const market of targets) {
        socket.send(
          JSON.stringify({
            method: "subscribe",
            requestId: requestRef.current++,
            params: [`predictOrderbook/${market.id}`],
          }),
        );
      }
    };

    socket.onmessage = (event) => {
      if (typeof event.data !== "string") return;
      let payload: { type?: string; topic?: string; data?: unknown };
      try {
        payload = JSON.parse(event.data) as typeof payload;
      } catch {
        return;
      }
      // 心跳：原样回显时间戳，格式固定且没有 requestId。
      if (payload.topic === "heartbeat") {
        socket.send(JSON.stringify({ method: "heartbeat", data: payload.data }));
        return;
      }
      if (payload.type !== "M" || typeof payload.topic !== "string") return;
      if (!payload.topic.startsWith("predictOrderbook/")) return;

      const data = payload.data as BookData | undefined;
      if (!data || typeof data.marketId !== "number") return;
      const receivedAt = Date.now();
      setBooks((prev) => ({ ...prev, [data.marketId]: { ...data, receivedAt } }));

      // 每次推送里的 lastOrderSettled 是最近一笔结算 ⇒ 累积起来就是实时成交流。
      const settled = data.lastOrderSettled;
      if (settled && (settled.price || settled.id !== undefined)) {
        // 有人成交 ⇒ 他的持仓可能刚变了 ⇒ 立刻拉一次（节流）。
        const at = Date.now();
        if (at - lastTradePullRef.current >= TRADE_THROTTLE_MS) {
          lastTradePullRef.current = at;
          pullRef.current();
        }
        const key = `${data.marketId}:${settled.id ?? "?"}:${settled.price ?? "?"}:${settled.side ?? ""}`;
        setTrades((prev) => {
          if (prev.some((item) => item.key === key)) return prev;
          return [
            {
              key,
              at: receivedAt,
              label: labelRef.current.get(data.marketId) ?? `#${data.marketId}`,
              price: String(settled.price ?? "—"),
              kind: String(settled.kind ?? "—"),
              side: String(settled.side ?? "—"),
            },
            ...prev,
          ].slice(0, MAX_TRADES);
        });
      }
    };

    socket.onerror = () => setWsError("WebSocket 连接出错");
    socket.onclose = () => {
      setStatus("CLOSED");
      socketRef.current = null;
      if (stopRef.current) return;
      const delay = BACKOFF_MS[Math.min(retryRef.current, BACKOFF_MS.length - 1)]!;
      retryRef.current += 1;
      timerRef.current = setTimeout(() => connectRef.current(targets), delay);
    };
  }, []);

  useEffect(() => {
    connectRef.current = connect;
    pullRef.current = () => void loadPositions();
  }, [connect, loadPositions]);

  useEffect(() => {
    // 推迟一拍：effect 体里同步 setState 会被 react-hooks 规则判为级联渲染。
    const kick = setTimeout(() => {
      void loadPositions();
      void loadHistory();
      void loadMatches();
    }, 0);
    const poll = setInterval(() => void loadPositions(), POSITIONS_INTERVAL_MS);
    const fills = setInterval(() => void loadMatches(), MATCHES_INTERVAL_MS);
    const tick = setInterval(() => setClock(Date.now()), 1_000);
    return () => {
      clearTimeout(kick);
      clearInterval(poll);
      clearInterval(fills);
      clearInterval(tick);
      stopRef.current = true;
      if (timerRef.current) clearTimeout(timerRef.current);
      socketRef.current?.close();
    };
  }, [loadPositions, loadHistory, loadMatches]);

  useEffect(() => {
    if (markets.length === 0) return;
    stopRef.current = true;
    socketRef.current?.close();
    const handle = setTimeout(() => connect(markets), 50);
    return () => clearTimeout(handle);
  }, [markets, connect]);

  const filtered = useMemo(
    () =>
      positions.filter(
        (p) =>
          (p.market?.categorySlug ?? "").startsWith(TARGET_SLUG) &&
          p.market?.status !== SETTLED_STATUS,
      ),
    [positions],
  );
  const rounds = useMemo(() => pairOf(filtered), [filtered]);

  /** 被剔掉的已结算腿数 —— 显式告诉用户，免得又被「无」吓一跳。 */
  const settledHidden = useMemo(
    () =>
      positions.filter(
        (p) =>
          (p.market?.categorySlug ?? "").startsWith(TARGET_SLUG) &&
          p.market?.status === SETTLED_STATUS,
      ).length,
    [positions],
  );

  const totals = useMemo(() => {
    const pnl = rounds.reduce((sum, row) => sum + row.pnl, 0);
    const matched = rounds.reduce((sum, row) => sum + row.matched, 0);
    const naked = rounds.reduce((sum, row) => sum + row.naked, 0);
    const costs = rounds
      .map((row) => row.pairCost)
      .filter((value): value is number => value !== null);
    const median = costs.length
      ? [...costs].sort((a, b) => a - b)[Math.floor(costs.length / 2)]!
      : null;
    const pairedPct = matched + naked > 0 ? (2 * matched) / (2 * matched + naked) : 0;
    return { pnl, matched, naked, median, pairedPct, count: rounds.length };
  }, [rounds]);

  const history = useMemo(() => historyRounds(closed), [closed]);

  const historyStats = useMemo(() => {
    const settled = history.filter((row) => row.matched > 0 || row.pnl !== 0);
    const costs = history
      .map((row) => row.pairCost)
      .filter((value): value is number => value !== null);
    const sorted = [...costs].sort((a, b) => a - b);
    const pnl = settled.reduce((sum, row) => sum + row.pnl, 0);
    return {
      count: settled.length,
      pnl,
      win: settled.length
        ? settled.filter((row) => row.pnl > 0).length / settled.length
        : 0,
      medianCost: sorted.length ? sorted[Math.floor(sorted.length / 2)]! : null,
      medianPaired: settled.length
        ? [...settled.map((row) => row.pairedPct)].sort((a, b) => a - b)[
            Math.floor(settled.length / 2)
          ]!
        : 0,
    };
  }, [history]);

  const pairGroups = useMemo(() => pairMatches(matches), [matches]);
  const fullRoundGroup = useMemo(
    () => (selectedRound ? pairMatches(fullRoundMatches).find((group) => group.key === selectedRound) ?? null : null),
    [selectedRound, fullRoundMatches],
  );
  const viewMatches = selectedRound && fullRoundMatches.length > 0 ? fullRoundMatches : matches;
  const displayPairGroups = useMemo(() => {
    if (!fullRoundGroup) return pairGroups;
    const existing = pairGroups.some((group) => group.key === fullRoundGroup.key);
    return existing
      ? pairGroups.map((group) => (group.key === fullRoundGroup.key ? fullRoundGroup : group))
      : [fullRoundGroup, ...pairGroups];
  }, [fullRoundGroup, pairGroups]);
  const analysisGroups = selectedRound && fullRoundGroup ? [fullRoundGroup] : pairGroups;

  const matchStats = useMemo(() => {
    const buy = viewMatches.filter((row) => row.side.toLowerCase() === "bid");
    const maker = buy.filter((row) => row.role === "MAKER").length;
    const shares = viewMatches.reduce((sum, row) => sum + row.shares, 0);
    return {
      count: viewMatches.length,
      makerShare: buy.length ? maker / buy.length : 0,
      shares,
      avgSize: viewMatches.length ? shares / viewMatches.length : 0,
    };
  }, [viewMatches]);
  const pairStats = useMemo(() => {
    const pairedShares = analysisGroups.reduce((sum, group) => sum + group.pairedShares, 0);
    const naked = analysisGroups.reduce((sum, group) => sum + group.naked, 0);
    const pairCostValue = analysisGroups.reduce(
      (sum, group) => sum + (group.pairCost ?? 0) * group.pairedShares,
      0,
    );
    return {
      rounds: pairGroups.length,
      pairedShares,
      naked,
      pairCost: pairedShares > 0 ? pairCostValue / pairedShares : null,
    };
  }, [analysisGroups]);

  const bookRows = useMemo(
    () =>
      markets.map((market) => {
        const book = books[market.id];
        const bid = topOf(book?.bids);
        const ask = topOf(book?.asks);
        return {
          id: market.id,
          label: labels[market.id] ?? `#${market.id}`,
          book,
          bid,
          ask,
          mid: bid && ask ? (bid[0] + ask[0]) / 2 : null,
          stale: book ? clock - book.receivedAt > STALE_MS : true,
        };
      }),
    [markets, books, labels, clock],
  );

  return (
    <div className="workspace-page leaderboard-page">
      <PageTitle
        title="BTC 5 分钟监控"
        subtitle="只盯目标账户的 BTC 5 分钟市场。持仓靠 REST 拉取（公开 WS 没有「按地址推持仓」的主题），但由 WS 的成交推送触发刷新。"
        icon={<Activity size={22} />}
        actions={
          <div className="actions leaderboard-actions">
            <Button onClick={() => void loadPositions()} title="立即拉一次持仓">
              <RefreshCw size={15} />
              刷新持仓
            </Button>
          </div>
        }
      />

      <div className="leaderboard-meta">
        <span className="leaderboard-address mono">{WALLET_ADDRESS}</span>
        <Badge tone={positionError ? "red" : "green"}>
          {positionError ? <CircleAlert size={12} /> : <Wifi size={12} />}
          {positionError ? "持仓请求异常" : "持仓：成交触发 + 兜底轮询"}
        </Badge>
        <Badge tone={status === "OPEN" ? "green" : "red"}>
          {status === "OPEN" ? <Wifi size={12} /> : <WifiOff size={12} />}
          盘口 {status === "OPEN" ? "已连接" : status === "CONNECTING" ? "连接中" : "未连接"}
        </Badge>
        <span className="small">
          BTC 5m {rounds.length} 局 · 更新于 {updatedAt ? time(updatedAt) : "—"}
        </span>
      </div>

      {positionError && (
        <div className="notice red" role="alert">
          持仓请求失败：{positionError}
        </div>
      )}
      {wsError && (
        <div className="notice red" role="alert">
          {wsError}
        </div>
      )}

      <div className="metrics leaderboard-metrics">
        <Metric
          label="配对份额"
          value={`${(totals.pairedPct * 100).toFixed(1)}%`}
          foot="2·min/(up+dn)；1 = 涨跌赔付完全相同"
        />
        <Metric label="裸敞口" value={formatShares(totals.naked)} foot={`配对 ${formatShares(totals.matched)} 股`} />
        <Metric
          label="配对成本 中位"
          value={totals.median === null ? "—" : totals.median.toFixed(4)}
          foot="两腿均价之和；< 1 才赚"
        />
        <Metric label="当前盈亏" value={totals.pnl.toFixed(2)} foot={`${totals.count} 个市场`} />
      </div>

      <Panel
        title={`他的 BTC 5m 持仓（${rounds.length} 局）`}
        aside={
          <span className="small">
            {settledHidden > 0
              ? `已隐藏 ${settledHidden} 条已结算残腿（赢腿赎回即消失）`
              : "按合约配对"}
          </span>
        }
      >
        {rounds.length === 0 ? (
          <div className="small" style={{ padding: 16 }}>
            {positionError ? "持仓拉取失败" : "等待持仓数据…"}
          </div>
        ) : (
          <div className="ws-monitor holdings" role="table" aria-label="他的持仓">
            <div className="ws-monitor-row head" role="row">
              <span>市场</span>
              <span>状态</span>
              <span>UP 持仓</span>
              <span>DOWN 持仓</span>
              <span>偏重</span>
              <span>配对%</span>
              <span>裸敞口</span>
              <span>配对成本</span>
              <span>盈亏</span>
            </div>
            {rounds.map((row) => (
              <div className="ws-monitor-row" role="row" key={row.key}>
                <span className="mono" title={row.title}>
                  {row.title.slice(-30)}
                </span>
                <span>
                  <Badge tone={row.status === "REGISTERED" ? "green" : "yellow"}>
                    {row.status === "REGISTERED"
                      ? "进行中"
                      : row.status === "PRICE_PROPOSED"
                        ? "结算中"
                        : row.status || "—"}
                  </Badge>
                </span>
                <span className="mono">
                  {row.up ? (
                    `涨 ${formatShares(row.up.shares)} @ ${row.up.avg.toFixed(4)}`
                  ) : (
                    <span className="negative" title="这一腿没有持仓：开盘瞬间可能只成交了一边">
                      无
                    </span>
                  )}
                </span>
                <span className="mono">
                  {row.down ? (
                    `跌 ${formatShares(row.down.shares)} @ ${row.down.avg.toFixed(4)}`
                  ) : (
                    <span className="negative" title="这一腿没有持仓：开盘瞬间可能只成交了一边">
                      无
                    </span>
                  )}
                </span>
                <span>
                  {row.heavy ? (
                    <Badge tone={row.heavy === "UP" ? "green" : "red"}>
                      {row.heavy === "UP" ? "偏涨" : "偏跌"}
                    </Badge>
                  ) : (
                    <Badge tone="green">持平</Badge>
                  )}
                </span>
                <span className="mono strong">{(row.pairedPct * 100).toFixed(1)}%</span>
                <span className={`mono ${row.naked > 0 ? "negative" : ""}`}>
                  {formatShares(row.naked)}
                </span>
                <span className="mono">
                  {row.pairCost === null ? "—" : row.pairCost.toFixed(4)}
                </span>
                <span className={`mono ${row.pnl >= 0 ? "positive" : "negative"}`}>
                  {row.pnl.toFixed(2)}
                </span>
              </div>
            ))}
          </div>
        )}
      </Panel>

      <div className="metrics leaderboard-metrics">
        <Metric
          label="历史真实盈亏"
          value={`${historyStats.pnl >= 0 ? "+" : ""}${historyStats.pnl.toFixed(0)}`}
          foot={`Binance 已结算 · ${historyStats.count} 局（直出，非重建）`}
        />
        <Metric
          label="历史盈利局"
          value={`${(historyStats.win * 100).toFixed(0)}%`}
          foot="按两腿 pnl 之和是否为正"
        />
        <Metric
          label="历史配对成本 中位"
          value={historyStats.medianCost === null ? "—" : historyStats.medianCost.toFixed(4)}
          foot="两腿 avgPrice 之和；< 1 才赚"
        />
        <Metric
          label="历史配对份额 中位"
          value={`${(historyStats.medianPaired * 100).toFixed(1)}%`}
          foot="结算金额的平衡程度"
        />
      </div>

      <Panel
        title={`历史真实表现（BTC 5m · ${history.length} 局）`}
        aside={
          <span className="small">
            {historyBusy ? "加载中…" : "来自 Binance 已结算持仓，pnl 为接口直出"}
          </span>
        }
      >
        {history.length === 0 ? (
          <div className="small" style={{ padding: 16 }}>
            {historyBusy ? "正在拉取历史…" : "暂无历史数据"}
          </div>
        ) : (
          <div className="ws-monitor holdings" role="table" aria-label="历史真实表现">
            <div className="ws-monitor-row head" role="row">
              <span>时间</span>
              <span>UP 均价</span>
              <span>DOWN 均价</span>
              <span>结果</span>
              <span>配对%</span>
              <span>裸敞口</span>
              <span>配对成本</span>
              <span>盈亏</span>
            </div>
            {history.slice(0, 40).map((row) => (
              <div className="ws-monitor-row" role="row" key={row.key}>
                <span className="mono small" title={row.title}>
                  {row.title.replace(/^[A-Za-z ]*Up or Down - /, "").slice(0, 22)}
                </span>
                <span className="mono">{row.upAvg > 0 ? row.upAvg.toFixed(4) : "—"}</span>
                <span className="mono">{row.downAvg > 0 ? row.downAvg.toFixed(4) : "—"}</span>
                <span>
                  {row.winner ? (
                    <Badge tone={row.winner === "UP" ? "green" : "red"}>
                      {row.winner === "UP" ? "涨赢" : "跌赢"}
                    </Badge>
                  ) : (
                    <Badge tone="yellow">—</Badge>
                  )}
                </span>
                <span className="mono strong">{(row.pairedPct * 100).toFixed(1)}%</span>
                <span className="mono">{row.naked.toFixed(0)}</span>
                <span className="mono">
                  {row.pairCost === null ? "—" : row.pairCost.toFixed(4)}
                </span>
                <span className={`mono ${row.pnl >= 0 ? "positive" : "negative"}`}>
                  {row.pnl.toFixed(2)}
                </span>
              </div>
            ))}
          </div>
        )}
      </Panel>

      <Panel
        title={"他的 BTC 5m 逐笔成交（" + viewMatches.length + " 笔）"}
        aside={
          <div className="match-panel-aside">
              <span className="small">
              挂单占 {(matchStats.makerShare * 100).toFixed(0)}% · 笔均 {formatShares(matchStats.avgSize)} 股
            </span>
            <label className="history-round-picker">
              <span>历史轮次</span>
              <select
                value={selectedHistoryKey}
                disabled={fullRoundBusy || history.length === 0}
                onChange={(event) => {
                  const key = event.currentTarget.value;
                  if (!key) {
                    setSelectedHistoryKey("");
                    setSelectedRound(null);
                    setFullRoundMatches([]);
                    setFullRoundError(null);
                    return;
                  }
                  const row = history.find((item) => item.key === key);
                  if (row) void loadHistoricalRound(row);
                }}
              >
                <option value="">选择一局历史成交…</option>
                {history.filter((row) => row.predictSlug).map((row) => (
                  <option key={row.key} value={row.key}>
                    {row.title.replace(/^Bitcoin Up or Down - /, "").slice(0, 42)}
                  </option>
                ))}
              </select>
            </label>
            <div className="match-switch" role="group" aria-label="成交展示方式">
              <button type="button" className={matchView === "paired" ? "active" : ""} onClick={() => setMatchView("paired")}>
                配对分析
              </button>
              <button type="button" className={matchView === "raw" ? "active" : ""} onClick={() => setMatchView("raw")}>
                原始逐笔
              </button>
            </div>
          </div>
        }
      >
        {viewMatches.length === 0 ? (
          <div className="small" style={{ padding: 16 }}>等待成交记录…</div>
        ) : matchView === "paired" ? (
          <div className="pair-analysis">
            <div className="pair-summary-strip" aria-live="polite">
              <span><small>涉及轮次</small><strong>{pairStats.rounds}</strong></span>
              <span><small>FIFO 已配对</small><strong>{formatTradeShares(pairStats.pairedShares)} 股</strong></span>
              <span className={pairStats.naked > 0 ? "warning" : ""}><small>未配对敞口</small><strong>{formatTradeShares(pairStats.naked)} 股</strong></span>
              <span><small>配对均价</small><strong>{pairStats.pairCost === null ? "—" : pairStats.pairCost.toFixed(4)}</strong></span>
            </div>
            <p className="pair-note">
              配对分析按同一 BTC 5m 轮次、时间先后 FIFO 估算；它能看出涨跌数量如何抵消，但成交接口没有提供钱包真实的配对意图。
            </p>
            <div className="pair-groups">
              {displayPairGroups.map((group) => {
                const showingFull = selectedRound === group.key && fullRoundGroup !== null;
                const displayGroup = showingFull ? fullRoundGroup : group;
                const displayPairs = showingFull ? displayGroup.pairs : displayGroup.pairs.slice(0, 80);
                return (
                <section className="match-round" key={group.key}>
                  <header className="match-round-head">
                    <div>
                      <strong>{matchMarketLabel(displayGroup.slug)}</strong>
                      <span className="small">最近成交 {time(displayGroup.latestAt)}</span>
                    </div>
                    <div className="match-round-metrics">
                      <span>涨 <b>{formatTradeShares(displayGroup.upShares)}</b></span>
                      <span>跌 <b>{formatTradeShares(displayGroup.downShares)}</b></span>
                      <span className={displayGroup.naked > 0 ? "warning" : ""}>裸敞口 <b>{formatTradeShares(displayGroup.naked)}</b></span>
                    </div>
                    <div className="match-round-tools">
                      {showingFull && <span className="small">完整 {fullRoundMatches.length} 笔</span>}
                      <button type="button" onClick={() => void loadFullRound(group)} disabled={fullRoundBusy}>
                        {selectedRound === group.key && fullRoundBusy ? "查询中…" : showingFull ? "重新查询" : "查询完整"}
                      </button>
                    </div>
                  </header>
                  {selectedRound === group.key && fullRoundError && <div className="pair-load-error">完整成交查询失败：{fullRoundError}</div>}
                  {showingFull && <RoundReplayChart rows={fullRoundMatches} slug={displayGroup.slug} />}
                  <div className="pair-column-head">
                    <span>涨 UP 成交</span>
                    <span>FIFO 配对</span>
                    <span>跌 DOWN 成交</span>
                  </div>
                  {displayPairs.map((pair) => (
                    <div className="pair-line" key={pair.key}>
                      <div className="pair-fill up">
                        <span className="fill-arrow">↗</span>
                        <div><strong>{formatTradeShares(pair.shares)} 股 @ {pair.up.price.toFixed(3)}</strong><small>{time(pair.up.at)} · {pair.up.role === "MAKER" ? "挂单" : "吃单"}</small></div>
                      </div>
                      <div className="pair-link">
                        <strong>{formatTradeShares(pair.shares)}</strong>
                        <small>配对</small>
                        <span>成本 {(pair.up.price + pair.down.price).toFixed(3)}</span>
                      </div>
                      <div className="pair-fill down">
                        <span className="fill-arrow">↘</span>
                        <div><strong>{formatTradeShares(pair.shares)} 股 @ {pair.down.price.toFixed(3)}</strong><small>{time(pair.down.at)} · {pair.down.role === "MAKER" ? "挂单" : "吃单"}</small></div>
                      </div>
                    </div>
                  ))}
                  {!showingFull && group.pairs.length > 80 && <div className="pair-more">当前显示前 80 组；点击“查询完整”加载该轮全部成交。</div>}
                  {displayGroup.naked > 0 && (
                    <div className={"pair-residual " + (displayGroup.nakedSide === "UP" ? "up" : "down")}>
                      <span className="fill-arrow">{displayGroup.nakedSide === "UP" ? "↗" : "↘"}</span>
                      <strong>未配对 {formatTradeShares(displayGroup.naked)} 股</strong>
                      <span>当前偏{displayGroup.nakedSide === "UP" ? "涨" : "跌"}，这部分是该轮剩余方向敞口</span>
                    </div>
                  )}
                </section>
                );
              })}
            </div>
          </div>
        ) : (
          <div className="ws-trades">
            <div className="ws-trade head">
              <span>时间</span>
              <span>市场</span>
              <span>腿</span>
              <span>价格</span>
              <span>数量</span>
              <span>角色</span>
              <span>订单</span>
            </div>
            {viewMatches.map((row, index) => (
              <div className="ws-trade" key={row.at + ":" + row.hash + ":" + index}>
                <span className="small">{time(row.at)}</span>
                <span className="mono small" title={row.slug}>
                  {row.slug.replace(/^btc-updown-5m-/, "5m-").slice(0, 16)}
                </span>
                <span>
                  <Badge tone={row.leg.toLowerCase().startsWith("up") ? "green" : "red"}>
                    {row.leg.toLowerCase().startsWith("up") ? "涨" : "跌"}
                  </Badge>
                </span>
                <span className="mono strong">{row.price.toFixed(3)}</span>
                <span className="mono">{formatTradeShares(row.shares)}</span>
                <span>
                  <Badge tone={row.role === "MAKER" ? "green" : "red"}>
                    {row.role === "MAKER" ? "挂单" : "吃单"}
                  </Badge>
                </span>
                <span className="mono small">{row.hash}</span>
              </div>
            ))}
          </div>
        )}
      </Panel>

      <Panel
        title="实时盘口（WebSocket）"
        aside={<span className="small">辅助信息 · 每 15 秒回显心跳</span>}
      >
        {bookRows.length === 0 ? (
          <div className="small" style={{ padding: 16 }}>
            未订阅到盘口（不影响上面的持仓监控）
          </div>
        ) : (
          <div className="ws-monitor" role="table" aria-label="实时盘口">
            <div className="ws-monitor-row head" role="row">
              <span>市场</span>
              <span>买一</span>
              <span>卖一</span>
              <span>价差</span>
              <span>中间价</span>
              <span>挂单张数</span>
              <span>最近结算</span>
              <span>更新</span>
            </div>
            {bookRows.map((row) => (
              <div className="ws-monitor-row" role="row" key={row.id}>
                <span className="mono">{row.label}</span>
                <span className="mono">{row.bid ? row.bid[0].toFixed(2) : "—"}</span>
                <span className="mono">{row.ask ? row.ask[0].toFixed(2) : "—"}</span>
                <span className="mono">
                  {row.bid && row.ask ? (row.ask[0] - row.bid[0]).toFixed(2) : "—"}
                </span>
                <span className="mono strong">{row.mid === null ? "—" : row.mid.toFixed(4)}</span>
                <span className="mono">{row.book?.orderCount ?? "—"}</span>
                <span className="mono small">
                  {row.book?.lastOrderSettled
                    ? `${row.book.lastOrderSettled.price ?? "—"} ${row.book.lastOrderSettled.kind ?? ""}`.trim()
                    : "—"}
                </span>
                <span className={`small ${row.stale ? "negative" : ""}`}>
                  {row.book ? `${Math.round((clock - row.book.receivedAt) / 1000)}s` : "等待"}
                </span>
              </div>
            ))}
          </div>
        )}
      </Panel>

      <Panel
        title="实时成交流"
        aside={<span className="small">LIMIT = 挂单被动成交，MARKET = 主动吃单</span>}
      >
        {trades.length === 0 ? (
          <div className="small" style={{ padding: 16 }}>
            等待成交推送…
          </div>
        ) : (
          <div className="ws-trades">
            {trades.map((trade) => (
              <div className="ws-trade" key={trade.key}>
                <span className="small">{time(trade.at)}</span>
                <span className="mono">{trade.label}</span>
                <span className="mono strong">{trade.price}</span>
                <Badge tone={trade.kind === "MARKET" ? "red" : "green"}>{trade.kind}</Badge>
                <span className="small">{trade.side}</span>
              </div>
            ))}
          </div>
        )}
      </Panel>
    </div>
  );
}
