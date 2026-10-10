#!/usr/bin/env node
/**
 * 盘口采集器：长期订阅 predict.fun 的 orderbook 推送并落盘 NDJSON。
 *
 * ## 为什么需要它
 *
 * 做市（maker）回测必须知道「某个价位上挂着多少量、盘口长什么样」，而成交
 * 记录里只有被动成交的结果、没有当时的盘口。用成交流反推挂单能否成交，等于
 * 先假设一个规则再验证它——那样任何结论都能调出来，没有意义。
 *
 * 所以先把盘口**观测**下来，之后的 maker 回测才是可证伪的。
 *
 * ## 为什么是独立进程而不是页面里的 WebSocket
 *
 * 页面里的连接随标签页关闭而断开，且浏览器不能带自定义 header。这个脚本
 * 独立运行、只读 .env 里的 key、断线自动重连，适合连续跑几天。
 *
 * ## 落盘格式
 *
 * 每行一个 JSON（NDJSON），追加写。按 UTC 小时切文件，便于分段读取：
 *   data/books/2026-10-10T09.ndjson
 *
 *   {"u":<交易所推送时间戳 ms>,"t":<本地接收 ms>,"m":<marketId>,"s":<slot>,
 *    "b":[[价,量],...],"a":[[价,量],...],"n":<挂单数>,
 *    "ls":<lastOrderSettled 原样>}
 *
 * 用法:
 *   node scripts/record-books.mjs                  # 一直跑，Ctrl-C 停止
 *   node scripts/record-books.mjs --minutes 30     # 跑 30 分钟
 *   node scripts/record-books.mjs --out /tmp/books # 换输出目录
 */

import { appendFile, mkdir } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");

const WS_URL = "wss://ws.predict.fun/ws";
const PREDICT_BASE = "https://api.predict.fun";
/** 与 leaderboard-page.tsx 保持一致的退避序列。 */
const BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 15_000];
const SLOT_SECONDS = 300;
const SERIES_SLUG = "btc-updown-5m-";
/** 提前量：订阅下一个 slot，避免开盘瞬间没有盘口数据。 */
const LOOKAHEAD_SLOTS = 1;

/** 从 .env 读 key。不打印、不写日志。 */
function loadApiKey() {
	const path = join(ROOT, ".env");
	let text;
	try {
		text = readFileSync(path, "utf8");
	} catch {
		console.error("读不到 .env，请先创建并填入 PREDICT_API_KEY");
		process.exit(1);
	}
	for (const line of text.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;
		const eq = trimmed.indexOf("=");
		if (eq < 0) continue;
		if (trimmed.slice(0, eq).trim() === "PREDICT_API_KEY") {
			return trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
		}
	}
	console.error(".env 里没有 PREDICT_API_KEY");
	process.exit(1);
}

const API_KEY = loadApiKey();

/** 解析参数。保持极简，不引依赖。 */
function parseArgs(argv) {
	let minutes = 0;
	let out = join(ROOT, "data", "books");
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === "--minutes") minutes = Number(argv[++i]) || 0;
		else if (argv[i] === "--out") out = argv[++i];
	}
	return { minutes, out };
}

const ARGS = parseArgs(process.argv.slice(2));

async function api(path) {
	const response = await fetch(`${PREDICT_BASE}${path}`, {
		headers: { "x-api-key": API_KEY, Accept: "application/json" },
		signal: AbortSignal.timeout(15_000),
	});
	if (!response.ok) throw new Error(`${path} → HTTP ${response.status}`);
	return response.json();
}

/**
 * 解析一个 slot 对应的 marketId。
 * 用 /v1/categories/{slug} —— 这是实测可用的路径，返回里 markets[0].id
 * 就是订阅 predictOrderbook 时要用的 id。
 */
async function marketIdForSlot(slot) {
	const slug = `${SERIES_SLUG}${slot}`;
	const payload = await api(`/v1/categories/${slug}`);
	const markets = payload?.data?.markets;
	if (!Array.isArray(markets) || markets.length === 0) return null;
	const market = markets[0];
	// 只在真正可交易时订阅，否则会白白占用订阅额度。
	if (market.tradingStatus && market.tradingStatus !== "OPEN") return null;
	return typeof market.id === "number" ? market.id : null;
}

function currentSlot(at = Date.now()) {
	return Math.floor(at / 1000 / SLOT_SECONDS) * SLOT_SECONDS;
}

/** 按 UTC 小时切文件，避免单文件无限增长。 */
function fileForRow(at) {
	const iso = new Date(at).toISOString();
	return join(ARGS.out, `${iso.slice(0, 13)}.ndjson`);
}

let written = 0;
let dropped = 0;
let lastSlot = 0;

async function persist(row) {
	const path = fileForRow(row.t);
	try {
		await appendFile(path, `${JSON.stringify(row)}\n`);
		written++;
	} catch (cause) {
		// 写失败不能拖垮采集：记一次丢包计数，继续跑。
		dropped++;
		if (dropped % 100 === 1) {
			console.error(`落盘失败（累计 ${dropped} 行）:`, cause.message);
		}
	}
}

async function main() {
	await mkdir(ARGS.out, { recursive: true });
	console.log(`输出目录 ${ARGS.out}`);
	if (ARGS.minutes > 0) console.log(`运行 ${ARGS.minutes} 分钟后自动停止`);

	let stop = false;
	const deadline = ARGS.minutes > 0 ? Date.now() + ARGS.minutes * 60_000 : null;
	const stopTimer = deadline
		? setInterval(() => {
				if (Date.now() >= deadline) stop = true;
			}, 5_000)
		: null;

	process.on("SIGINT", () => {
		stop = true;
	});

	let attempt = 0;
	while (!stop) {
		const slot = currentSlot();
		let socket;
		try {
			socket = new WebSocket(WS_URL);
		} catch (cause) {
			console.error("建立 WebSocket 失败:", cause.message);
			await sleep(5_000);
			continue;
		}

		/** marketId → slot。用于给每行数据打上所属 slot。 */
		const subscribed = new Map();
		/** 已处理过的 slot（含正在解析中的），避免重复订阅。 */
		const handledSlots = new Set();
		let requestId = 1;
		let opened = false;

		socket.addEventListener("open", () => {
			opened = true;
			attempt = 0;
			console.log(`已连接，订阅 slot ${slot}`);
		});

		socket.addEventListener("message", async (event) => {
			if (typeof event.data !== "string") return;
			let payload;
			try {
				payload = JSON.parse(event.data);
			} catch {
				return;
			}
			if (payload.topic === "heartbeat") {
				socket.send(
					JSON.stringify({ method: "heartbeat", data: payload.data }),
				);
				return;
			}
			if (payload.type !== "M") return;
			if (typeof payload.topic !== "string") return;
			if (!payload.topic.startsWith("predictOrderbook/")) return;

			const data = payload.data;
			if (!data || typeof data.marketId !== "number") return;
			await persist({
				u: typeof data.updateTimestampMs === "number" ? data.updateTimestampMs : null,
				t: Date.now(),
				m: data.marketId,
				s: subscribed.get(data.marketId) ?? null,
				b: data.bids ?? [],
				a: data.asks ?? [],
				n: data.orderCount ?? null,
				ls: data.lastOrderSettled ?? null,
			});
		});

		socket.addEventListener("error", () => {
			// onclose 会跟着触发，重连逻辑统一放那里。
		});

		// 定期把「当前 slot 和下一个 slot」的订阅补上。每 30 秒检查一次，
		// 这样跨 slot 时不用重连。
		const subscribeTimer = setInterval(async () => {
			if (socket.readyState !== WebSocket.OPEN) return;
			const now = currentSlot();
			for (let k = 0; k <= LOOKAHEAD_SLOTS; k++) {
				const target = now + k * SLOT_SECONDS;
				if (handledSlots.has(target)) continue;
				handledSlots.add(target);
				try {
					const id = await marketIdForSlot(target);
					if (id === null) {
						// 市场还没开或已结束：允许下一轮重试。
						handledSlots.delete(target);
						continue;
					}
					if (subscribed.has(id)) continue;
					subscribed.set(id, target);
					socket.send(
						JSON.stringify({
							method: "subscribe",
							requestId: requestId++,
							params: [`predictOrderbook/${id}`],
						}),
					);
					console.log(`  订阅 market ${id}（slot ${target}）`);
				} catch (cause) {
					handledSlots.delete(target);
					console.error(`  解析 slot ${target} 失败:`, cause.message);
				}
			}
			// 清掉两轮之前的 slot 记录，避免长期运行时 map 无限增长。
			for (const [id, slot] of subscribed) {
				if (slot < now - SLOT_SECONDS) subscribed.delete(id);
			}
		}, 30_000);

		await new Promise((resolve) => {
			socket.addEventListener("close", resolve);
			const watch = setInterval(() => {
				if (stop) {
					clearInterval(watch);
					resolve();
				}
			}, 1_000);
		});

		clearInterval(subscribeTimer);
		try {
			socket.close();
		} catch {
			// 已经关了。
		}

		if (stop) break;
		const delay = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)];
		attempt++;
		console.log(`连接断开，${delay / 1000}s 后重连（第 ${attempt} 次）`);
		await sleep(delay);
	}

	if (stopTimer) clearInterval(stopTimer);
	console.log(`\n结束：写入 ${written} 行，落盘失败 ${dropped} 行`);
}

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((cause) => {
	console.error("采集器异常退出:", cause);
	process.exit(1);
});
