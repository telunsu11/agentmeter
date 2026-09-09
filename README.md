# ⚡ agentmeter — Coding Agent 的电表 + 用电审计 + 跳闸预警

[![CI](https://github.com/telunsu11/agentmeter/actions/workflows/ci.yml/badge.svg)](https://github.com/telunsu11/agentmeter/actions/workflows/ci.yml)

解析 Claude Code / ZCode / Codex / OpenCode 的本地会话日志，回答三个问题：

1. **token 花在哪了**——今日/本周/本月，按 agent、项目、模型、会话下钻
2. **哪些是无效消耗**——API 重试、失败循环、上下文重启、缓存空转、僵尸会话、重复读取
3. **配额还剩多少**——5h 滚动窗/日/周/月窗口监控，到阈值弹系统通知

**纯本地、零遥测、零运行时依赖。** 不改一行 agent 配置，装完即用。

## 快速开始

```bash
npx agentmeter            # 今日用量
npx agentmeter month      # 月度总览
npx agentmeter projects   # 哪个项目最烧
npx agentmeter waste      # 浪费审计（核心特色）
npx agentmeter web        # 本地仪表盘 http://127.0.0.1:8787
```

从源码运行：

```bash
git clone <repo> && cd coding-dashboard
npm install && npm run build
node dist/cli/main.js today
```

## 命令一览

| 命令 | 作用 |
|---|---|
| `agentmeter` / `today` | 今日汇总：按 agent / model，对比昨日 |
| `agentmeter week` | 近 7 天逐日用量（`--last N` 自定义天数） |
| `agentmeter month` | 月度用量表 + 本月 agent 细分 |
| `agentmeter projects` | 按项目目录聚合，看哪个项目最烧 |
| `agentmeter sessions` | 会话级明细 Top N（`--top 20`） |
| `agentmeter waste` | 浪费审计报告（详见下文） |
| `agentmeter quota` | 配额窗口使用进度 |
| `agentmeter watch` | 持续监控 + 阈值通知；`--once` 单次；`install` 生成自启动 |
| `agentmeter statusline` | Claude Code 状态栏集成 |
| `agentmeter web` | 本地仪表盘（仅 127.0.0.1，`--port` 可改） |
| `agentmeter sources` | 数据源诊断（各 agent 检测到多少文件/事件） |
| `agentmeter config init` | 打印示例配置（`--write` 直接落盘） |

通用参数：`--agent zcode,claude` 过滤 agent；`--since/--until YYYY-MM-DD`；`--json` 机器可读输出；`--cost` 显示成本估算（默认隐藏）；`--rescan` 全量重扫；`--tz` 时区覆盖。

## 浪费审计：六类信号

`agentmeter waste` 对每个会话的脱敏轨迹跑七类检测器：

| 信号 | 判定 | 浪费量口径 |
|---|---|---|
| **API 错误/重试** | `isApiErrorMessage`（Claude）、`attempt>1`（ZCode） | 该轮全部 token |
| **失败循环** | 同一工具 + 相似错误签名 ≥3 次 | 循环区间重复发送的上下文 |
| **上下文重启** | 缓存读取骤降 + 上下文收缩（compact/溢出特征） | 重建期 3 轮的缓存写 + 重读 |
| **缓存空转** | 单轮缓存读 >100K 且输出 <50 token | 该轮缓存读全量 |
| **僵尸会话** | 错误收尾 / 过半轮次报错 / 全程几乎零输出 | 会话输入侧全量 |
| **重复读取** | 同一文件被 Read/Grep ≥4 次 | 信号型（上下文膨胀来源定位） |
| **长会话税** | 单轮上下文（输入+缓存）≥15 万 token 后仍续跑 ≥3 轮 | 每轮超出健康线的重读量（按 input/缓存占比分摊） |

错误判重使用归一化签名哈希（数字/路径/引号内容抹除后 FNV），**报告里只有聚合数字，永远不落对话正文**。

## 配额预警

```bash
agentmeter config init --write    # 生成 ~/.config/agentmeter/config.json
```

```jsonc
{
  "quotas": {
    "claude": { "windows": [{ "type": "rolling", "hours": 5, "limitTokens": 44000000 }] },
    "zcode":  { "windows": [{ "type": "monthly", "limitTokens": 60000000 }] }
  },
  "alerts": { "thresholds": [0.8, 0.95], "notify": "osascript" }
}
```

```bash
agentmeter watch            # 前台守护，30s 一查（--interval N）
agentmeter watch install    # 生成 launchd（macOS）/ systemd timer（Linux）模板
```

同一窗口同一阈值只通知一次，窗口滚动回落后自动重新武装。

## Claude Code 状态栏

`~/.claude/settings.json`：

```json
{ "statusLine": { "type": "command", "command": "agentmeter statusline" } }
```

显示 `⚡46.10M today`；当天存在浪费信号时追加 `⚠浪费≈1.4M`；配置限额后追加最紧窗口的百分比（80%/95% 变色）。

## 数据源与隐私

| Agent | 本地路径 | 说明 |
|---|---|---|
| Claude Code | `~/.claude/projects/**/*.jsonl` | 含 sidechain 子代理；按 message.id 去重 |
| ZCode | `~/.zcode/cli/rollout/model-io-*.jsonl` | 项目目录从 system 提示词/工具路径推断 |
| Codex | `~/.codex/sessions/**/*.jsonl` | token_count 事件；cwd 来自 session_meta |
| OpenCode | `~/.local/share/opencode/opencode.db` | 经系统 `sqlite3` CLI 读取，无原生依赖 |

- 增量扫描：解析结果缓存在 `~/.cache/agentmeter/`，未变化的文件直接命中缓存（实测热扫描 ~12ms）
- 缓存只存聚合事件与脱敏轨迹（工具名/路径/错误哈希），不存任何对话内容
- 删除原始日志后历史统计保留
- web 仪表盘只绑定 127.0.0.1
- **零联网**：无遥测、无更新检查、无 CDN 依赖（价格表也是离线的）

## 成本估算口径

默认隐藏（`--cost` 开启）：订阅制（Claude Max、GLM Coding Plan 等）用户的真实成本与 API 牌价无关，agentmeter 以 **token 与配额百分比**为一等公民。`--cost` 在 today/week/month/projects 报表和 `--json` 输出中附加 `成本≈` 列（USD，基于 `pricing/defaults.json` 的公开牌价，可在配置 `pricing` 段按模型覆盖；无牌价的模型显示 `—`）。加权口径：`input + output + cacheWrite + cacheRead/10`。

## 开发

```bash
npm run dev -- today   # tsx 直跑 TS 源码（无需预编译）
npm run build          # tsc → dist/
npm test               # vitest（适配器 / 增量扫描 / 浪费检测 / 对齐 / 时区）
npm run typecheck
```

CI（GitHub Actions）在 Node 20/22/24 × Linux/macOS 上跑 typecheck + test + build。发布：打 `v*` tag 触发 release 工作流自动 `npm publish`（需在仓库 Secrets 配置 `NPM_TOKEN`），或本地 `npm run build && npm publish`。

架构：`src/adapters/*`（各 agent 日志 → 统一 `UsageEvent`/`TurnTrace`）→ `src/core`（增量扫描、聚合、成本、配额、浪费引擎）→ `src/cli`（命令与渲染）。新增 agent 只需实现一个 adapter。

## License

MIT
