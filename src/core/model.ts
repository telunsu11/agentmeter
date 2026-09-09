/**
 * 统一数据模型：所有 agent 适配器输出 UsageEvent 流，
 * 报告/审计/预警层只依赖这里的类型，不感知具体 agent 日志格式。
 */

export type AgentId = 'claude' | 'zcode' | 'codex' | 'opencode';

export const ALL_AGENTS: AgentId[] = ['claude', 'zcode', 'codex', 'opencode'];

/** 一次模型请求的用量（各 agent 最小公共粒度） */
export interface UsageEvent {
  /** ISO 8601 时间戳（请求完成时刻） */
  ts: string;
  agent: AgentId;
  sessionId: string;
  turnId?: string;
  /** 项目目录（来自 cwd / 会话元数据；推断不出来时为空串） */
  projectDir: string;
  /** 归一化模型名，如 "claude-sonnet-4-5", "glm-5.3" */
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  meta?: EventMeta;
}

export interface EventMeta {
  attempt?: number;
  isApiError?: boolean;
  requestId?: string;
  durationMs?: number;
  /** 内部辅助请求（如标题生成），计入总量但审计时忽略 */
  internal?: boolean;
  /** 子代理（sidechain / subagent）请求 */
  subagent?: boolean;
  /** 事件来源文件（调试用） */
  sourceFile?: string;
  /**
   * 跨行/跨批去重键（如 Claude 流式写入的多行共用一个 message.id）。
   * scanner 按 key 折叠，保留用量最大的一条（流式行 usage 单调递增）。
   */
  dedupKey?: string;
}

export interface TokenTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export const ZERO_TOTALS: TokenTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

export function addTokens(a: TokenTotals, b: TokenTotals): TokenTotals {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
  };
}

/** 一次"轮"的脱敏轨迹：浪费审计的输入，不含任何原始正文 */
export interface TurnTrace {
  ts: string;
  agent: AgentId;
  sessionId: string;
  projectDir: string;
  model: string;
  tokens: TokenTotals;
  /** 该轮内被调用的工具摘要 */
  tools: ToolCallSummary[];
  flags: {
    isApiError?: boolean;
    attempt?: number;
    internal?: boolean;
  };
}

export interface ToolCallSummary {
  name: string;
  /** 出现错误（is_error / 异常文本特征） */
  error?: boolean;
  /** 错误签名：归一化错误文本的 FNV 哈希（十六进制），仅用于判重，不含原文 */
  errSig?: string;
  /** 涉及的文件路径（如 Read/Write 的 file_path） */
  path?: string;
}

/* ---------------- 废弃审计 ---------------- */

export type WasteType =
  | 'api_retry' // API 错误 / attempt>1 的重试
  | 'failure_loop' // 同一工具+相似错误反复出现
  | 'context_restart' // 上下文溢出/compact 重启后的缓存重建
  | 'ineffective_cache' // 反复读大上下文但几乎没有产出
  | 'zombie_session' // 异常终止/几乎无产出的会话
  | 'duplicate_reads'; // 同一文件被反复读取

export interface WasteFinding {
  type: WasteType;
  /** high / medium / low —— 影响对浪费量估计的置信度 */
  severity: 'high' | 'medium' | 'low';
  agent: AgentId;
  sessionId: string;
  projectDir: string;
  /** 首次发生时间 */
  ts: string;
  /** 涉及轮数（detector 自定义含义） */
  count: number;
  tokensWasted: TokenTotals;
  /** 人读的说明（中文），用于 waste 报告 */
  detail: string;
  /** 定位：来源会话文件（若已知） */
  sourceFile?: string;
}

/* ---------------- 配置 ---------------- */

export interface QuotaWindow {
  /** 滚动窗口：rolling + hours；自然窗口：daily/weekly/monthly */
  type: 'rolling' | 'daily' | 'weekly' | 'monthly';
  hours?: number;
  /** 限额（token 总量，input+output+cache 之和按权重折算，见 quota.ts） */
  limitTokens?: number;
  /** 也可以按消息轮数限额（Claude Max 风格） */
  limitTurns?: number;
}

export interface AgentQuotaConfig {
  windows: QuotaWindow[];
}

export interface AgentMeterConfig {
  quotas?: Partial<Record<AgentId, AgentQuotaConfig>>;
  alerts?: {
    /** 触发通知的阈值，默认 [0.8, 0.95] */
    thresholds?: number[];
    /** macOS: osascript / linux: notify-send */
    notify?: 'osascript' | 'notify-send' | 'none';
  };
  pricing?: Record<string, ModelPriceOverride>;
  /** 各 agent 数据目录覆盖 */
  paths?: Partial<Record<AgentId, string>>;
  timezone?: string;
  /** waste 报告的灵敏度 */
  waste?: {
    loopMinRepeats?: number;
    duplicateReadMin?: number;
    minTokensToReport?: number;
  };
}

export type ModelPriceOverride = Partial<Omit<ModelPrice, 'match'>>;

export interface ModelPrice {
  /** 模型名匹配模式（小写子串匹配） */
  match: string;
  /** USD / 百万 token */
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
}
