# Leaderboard Monitor

独立的 Next.js 监控页，复制 Taurus 的 leaderboard 功能，用于查看钱包 `0x6da6…ae03` 的 BTC 5 分钟持仓、历史表现、逐笔成交和实时盘口。

## 启动

```bash
pnpm install
cp .env.example .env.local
# 编辑 .env.local，填入 predict.fun API Key
pnpm dev
```

打开 <http://localhost:3000>。

如果要让同一局域网的手机访问，运行：

```bash
pnpm dev:lan
```

然后在手机浏览器打开 `http://电脑的局域网 IP:3000`，例如 `http://192.168.1.20:3000`。手机和电脑需要连接同一个 Wi-Fi；如果打不开，需要允许 Node.js 通过系统防火墙。

页面本身不需要 Cloudflare Access 或登录。持仓和逐笔成交由 Next 服务端代理访问 predict.fun，因此 API Key 只放在 `.env.local` 服务端环境变量中；实时盘口使用 predict.fun 的公开 WebSocket。历史结算数据由服务端代理 Binance 公开接口。

## 失衡率

每局按 `|UP 份额 − DOWN 份额| / max(UP 份额, DOWN 份额)` 计算：0% 为配平，100% 为单边，无持仓显示 `—`。当前持仓汇总按各局较大侧份额加权，不抵消不同轮次的反向敞口。

历史列表和中位数使用两腿累计买入份额，未扣除卖出或赎回；缺腿、缺份额和零买入的轮次不计入中位数。成交分析与回放的失衡率仅基于已加载的成交数量。

## 数据链路

- `/api/positions`：目标钱包当前持仓
- `/api/matches`：目标钱包最近成交
- `/api/category`：把历史 BTC 5m 轮次 slug 解析成 predict.fun 市场 id
- `/api/history`：Binance 已结算持仓
- `wss://ws.predict.fun/ws`：盘口和实时成交推送
# leaderboard-monitor
