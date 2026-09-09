import { AgentMeterConfig, TokenTotals, TurnTrace, WasteFinding, WasteType, ZERO_TOTALS } from '../model.js';
import { rawTotal } from '../aggregate.js';
import { dayKey } from '../util.js';

/**
 * 浪费审计引擎：对每个会话的 TurnTrace 序列跑 6 类信号检测。
 * 输入是脱敏轨迹（只有 token 数、工具名、错误签名哈希），不触碰对话正文。
 *
 * 设计原则：
 * - 每个 detector 独立、可单测；engine 只做分组与汇总
 * - "浪费量"是估计值：按 detector 给出的口径写入 detail，诚实标注置信度
 */

export interface WasteOptions {
  /** 失败循环最小重复次数 */
  loopMinRepeats: number;
  /** 同文件重复读取阈值 */
  duplicateReadMin: number;
  /** 长会话税：单轮上下文健康线（token） */
  contextBloatTokens: number;
  /** 长会话税：越线后至少再跑的轮数 */
  contextBloatMinTurns: number;
}

export function defaultWasteOptions(config?: AgentMeterConfig): WasteOptions {
  return {
    loopMinRepeats: config?.waste?.loopMinRepeats ?? 3,
    duplicateReadMin: config?.waste?.duplicateReadMin ?? 4,
    contextBloatTokens: config?.waste?.contextBloatTokens ?? 150_000,
    contextBloatMinTurns: config?.waste?.contextBloatMinTurns ?? 3,
  };
}

export function detectWaste(
  traces: TurnTrace[],
  config?: AgentMeterConfig,
  since?: string,
  until?: string,
  /** 日期归属时区，与报表口径一致（默认 UTC） */
  tz = 'UTC',
): WasteFinding[] {
  const opts = defaultWasteOptions(config);
  const active = traces.filter((t) => {
    if (t.flags.internal) return false;
    // 时区感知的日期边界，与 today/week/month 报表一致
    const day = dayKey(t.ts, tz);
    if (since && day < since) return false;
    if (until && day > until) return false;
    return true;
  });

  const bySession = new Map<string, TurnTrace[]>();
  for (const t of active) {
    const key = `${t.agent}:${t.sessionId}`;
    const list = bySession.get(key) || [];
    list.push(t);
    bySession.set(key, list);
  }

  const findings: WasteFinding[] = [];
  for (const list of bySession.values()) {
    const sorted = list.slice().sort((a, b) => a.ts.localeCompare(b.ts));
    findings.push(...detectApiRetry(sorted));
    findings.push(...detectFailureLoops(sorted, opts));
    findings.push(...detectContextRestart(sorted));
    findings.push(...detectIneffectiveCache(sorted));
    findings.push(...detectZombieSession(sorted));
    findings.push(...detectDuplicateReads(sorted, opts));
    findings.push(...detectContextBloat(sorted, opts));
  }
  return findings;
}

/* ---------- 7. 长会话税：上下文超健康线后仍在续跑 ----------
 * 会话越长，每轮重读的上下文越大（边际成本递增）。
 * 检测"单轮上下文（输入+缓存读写）越过健康线后仍继续 ≥N 轮"的会话，
 * 浪费量 = 每轮超出健康线的部分（按 input/cacheRead/cacheWrite 占比分摊）。
 * 建议：/compact、开新会话、或让 agent 主动总结收尾。
 */
function detectContextBloat(traces: TurnTrace[], opts: WasteOptions): WasteFinding[] {
  const beyond: TurnTrace[] = [];
  let peak = 0;
  for (const t of traces) {
    const ctx = t.tokens.input + t.tokens.cacheRead + t.tokens.cacheWrite;
    if (ctx > peak) peak = ctx;
    if (ctx >= opts.contextBloatTokens) beyond.push(t);
  }
  if (beyond.length < opts.contextBloatMinTurns) return [];

  const head = traces[0];
  let inExcess = 0, crExcess = 0, cwExcess = 0;
  for (const t of beyond) {
    const ctx = t.tokens.input + t.tokens.cacheRead + t.tokens.cacheWrite;
    const excess = ctx - opts.contextBloatTokens;
    const ratio = ctx > 0 ? excess / ctx : 0;
    inExcess += Math.round(t.tokens.input * ratio);
    crExcess += Math.round(t.tokens.cacheRead * ratio);
    cwExcess += Math.round(t.tokens.cacheWrite * ratio);
  }
  const wasted = { input: inExcess, output: 0, cacheRead: crExcess, cacheWrite: cwExcess };
  return [
    {
      type: 'context_bloat',
      severity: 'medium',
      agent: head.agent,
      sessionId: head.sessionId,
      projectDir: head.projectDir,
      ts: beyond[0].ts,
      count: beyond.length,
      tokensWasted: wasted,
      detail:
        `上下文峰值 ${short(peak)} 超过健康线 ${short(opts.contextBloatTokens)} 后又续跑 ${beyond.length} 轮，` +
        `超出部分的重读约 ${fmt(wasted)} token；建议 /compact 或开新会话`,
    },
  ];
}

function sumTokens(traces: TurnTrace[], from = 0, to = traces.length): TokenTotals {
  let t: TokenTotals = ZERO_TOTALS;
  for (let i = from; i < to && i < traces.length; i++) {
    const k = traces[i].tokens;
    t = {
      input: t.input + k.input,
      output: t.output + k.output,
      cacheRead: t.cacheRead + k.cacheRead,
      cacheWrite: t.cacheWrite + k.cacheWrite,
    };
  }
  return t;
}

/* ---------- 1. API 错误 / 重试 ---------- */
function detectApiRetry(traces: TurnTrace[]): WasteFinding[] {
  const bad = traces.filter((t) => t.flags.isApiError === true || (t.flags.attempt ?? 1) > 1);
  if (bad.length === 0) return [];
  const wasted = sumTokens(bad);
  const head = traces[0];
  return [
    {
      type: 'api_retry',
      severity: 'high',
      agent: head.agent,
      sessionId: head.sessionId,
      projectDir: head.projectDir,
      ts: bad[0].ts,
      count: bad.length,
      tokensWasted: wasted,
      detail: `${bad.length} 次请求为 API 错误或重试（attempt>1），消耗 ${fmt(wasted)} token 且无有效产出`,
    },
  ];
}

/* ---------- 2. 失败循环：同一工具+相似错误反复出现 ---------- */
function detectFailureLoops(traces: TurnTrace[], opts: WasteOptions): WasteFinding[] {
  // 收集 (工具名, 错误签名) 的出现轨迹索引
  const occ = new Map<string, { name: string; indices: number[] }>();
  traces.forEach((t, i) => {
    for (const tool of t.tools) {
      if (!tool.error || !tool.errSig) continue;
      const key = `${tool.name}::${tool.errSig}`;
      const o = occ.get(key) || { name: tool.name, indices: [] };
      o.indices.push(i);
      occ.set(key, o);
    }
  });

  const findings: WasteFinding[] = [];
  for (const { name, indices } of occ.values()) {
    if (indices.length < opts.loopMinRepeats) continue;
    const from = indices[0];
    const to = indices[indices.length - 1] + 1;
    const wasted = sumTokens(traces, from, to);
    const head = traces[from];
    findings.push({
      type: 'failure_loop',
      severity: 'high',
      agent: head.agent,
      sessionId: head.sessionId,
      projectDir: head.projectDir,
      ts: head.ts,
      count: indices.length,
      tokensWasted: wasted,
      detail: `工具 ${name} 以相似错误连续失败 ${indices.length} 次，循环期间重复发送上下文消耗 ${fmt(wasted)} token`,
    });
  }
  return findings;
}

/* ---------- 3. 上下文重启：compact / 溢出后的缓存重建 ---------- */
function detectContextRestart(traces: TurnTrace[]): WasteFinding[] {
  const findings: WasteFinding[] = [];
  for (let i = 1; i < traces.length; i++) {
    const prev = traces[i - 1].tokens;
    const cur = traces[i].tokens;
    const hadCache = prev.cacheRead > 100_000;
    const lostCache = cur.cacheRead < prev.cacheRead * 0.05 && cur.cacheRead < 10_000;
    const contextShrunk = cur.input + cur.cacheRead < (prev.input + prev.cacheRead) * 0.6;
    if (hadCache && lostCache && contextShrunk) {
      // 重启后 3 轮内的缓存重建 + 未命中重读记为浪费
      const to = Math.min(i + 3, traces.length);
      let rebuild = ZERO_TOTALS;
      for (let j = i; j < to; j++) {
        rebuild = {
          input: rebuild.input + traces[j].tokens.input,
          output: 0,
          cacheRead: 0,
          cacheWrite: rebuild.cacheWrite + traces[j].tokens.cacheWrite,
        };
      }
      const head = traces[i];
      findings.push({
        type: 'context_restart',
        severity: 'medium',
        agent: head.agent,
        sessionId: head.sessionId,
        projectDir: head.projectDir,
        ts: head.ts,
        count: 1,
        tokensWasted: rebuild,
        detail: `检测到上下文重启/compact（缓存读取从 ${short(prev.cacheRead)} 骤降），重建期重读浪费约 ${fmt(rebuild)} token`,
      });
      i = to; // 跳过重建期，避免重复计数
    }
  }
  return findings;
}

/* ---------- 4. 空转轮：巨量缓存重读 + 几乎零产出 ---------- */
const IDLE_OUTPUT_MAX = 50;
const IDLE_CACHE_MIN = 100_000;

function detectIneffectiveCache(traces: TurnTrace[]): WasteFinding[] {
  const idle = traces.filter(
    (t) => t.tokens.output < IDLE_OUTPUT_MAX && t.tokens.cacheRead > IDLE_CACHE_MIN,
  );
  if (idle.length === 0) return [];
  let cacheRead = 0;
  for (const t of idle) cacheRead += t.tokens.cacheRead;
  const head = traces[0];
  return [
    {
      type: 'ineffective_cache',
      severity: 'low',
      agent: head.agent,
      sessionId: head.sessionId,
      projectDir: head.projectDir,
      ts: idle[0].ts,
      count: idle.length,
      tokensWasted: { input: 0, output: 0, cacheRead, cacheWrite: 0 },
      detail: `${idle.length} 轮重读了 ${short(cacheRead)} 缓存 token 但输出少于 ${IDLE_OUTPUT_MAX}（多为被打断或无效确认）`,
    },
  ];
}

/* ---------- 5. 僵尸会话 ---------- */
function detectZombieSession(traces: TurnTrace[]): WasteFinding[] {
  if (traces.length < 3) return [];
  const head = traces[0];
  const total = sumTokens(traces);
  const errors = traces.filter((t) => t.flags.isApiError).length;
  const last = traces[traces.length - 1];
  const lowOutput = total.output < 200 && traces.length >= 5;
  const errorHeavy = errors >= 3 && errors / traces.length >= 0.5;
  const endedInError = last.flags.isApiError === true;
  if (!lowOutput && !errorHeavy && !endedInError) return [];

  const wasted: TokenTotals = { input: total.input, output: 0, cacheRead: total.cacheRead, cacheWrite: total.cacheWrite };
  const reason = endedInError
    ? '会话最后以 API 错误收尾'
    : errorHeavy
      ? `超过一半的轮次（${errors}/${traces.length}）是 API 错误`
      : `全程 ${traces.length} 轮输出不足 200 token`;
  return [
    {
      type: 'zombie_session',
      severity: endedInError || errorHeavy ? 'high' : 'low',
      agent: head.agent,
      sessionId: head.sessionId,
      projectDir: head.projectDir,
      ts: head.ts,
      count: traces.length,
      tokensWasted: wasted,
      detail: `疑似无效会话：${reason}；输入侧消耗 ${fmt(wasted)} token`,
    },
  ];
}

/* ---------- 6. 重复读取同一文件 ---------- */
const READ_TOOLS = new Set(['read', 'readfile', 'grep', 'glob', 'cat']);

function detectDuplicateReads(traces: TurnTrace[], opts: WasteOptions): WasteFinding[] {
  const head = traces[0];
  const readCount = new Map<string, number>();
  for (const t of traces) {
    for (const tool of t.tools) {
      if (!tool.path) continue;
      const name = tool.name.toLowerCase();
      const isRead = READ_TOOLS.has(name) || name.includes('read') || name.includes('grep') || name.includes('glob');
      if (isRead) readCount.set(tool.path, (readCount.get(tool.path) || 0) + 1);
    }
  }
  const findings: WasteFinding[] = [];
  for (const [path, count] of readCount) {
    if (count < opts.duplicateReadMin) continue;
    findings.push({
      type: 'duplicate_reads',
      severity: 'low',
      agent: head.agent,
      sessionId: head.sessionId,
      projectDir: head.projectDir,
      ts: head.ts,
      count,
      tokensWasted: ZERO_TOTALS,
      detail: `文件 ${path} 被重复读取/搜索 ${count} 次（阈值 ${opts.duplicateReadMin}）；上下文膨胀的常见来源`,
    });
  }
  // 每会话只报最严重的 3 个路径
  return findings.sort((a, b) => b.count - a.count).slice(0, 3);
}

export function wasteTotals(findings: WasteFinding[]): { byType: Record<WasteType, TokenTotals>; grand: TokenTotals } {
  const byType = {
    api_retry: ZERO_TOTALS,
    failure_loop: ZERO_TOTALS,
    context_restart: ZERO_TOTALS,
    ineffective_cache: ZERO_TOTALS,
    zombie_session: ZERO_TOTALS,
    duplicate_reads: ZERO_TOTALS,
    context_bloat: ZERO_TOTALS,
  } as Record<WasteType, TokenTotals>;
  let grand = ZERO_TOTALS;
  for (const f of findings) {
    byType[f.type] = addT(byType[f.type], f.tokensWasted);
    grand = addT(grand, f.tokensWasted);
  }
  return { byType, grand };
}

function addT(a: TokenTotals, b: TokenTotals): TokenTotals {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
  };
}

export function fmt(t: TokenTotals): string {
  const parts: string[] = [];
  if (t.input) parts.push(`${short(t.input)} 输入`);
  if (t.cacheRead) parts.push(`${short(t.cacheRead)} 缓存读`);
  if (t.cacheWrite) parts.push(`${short(t.cacheWrite)} 缓存写`);
  if (t.output) parts.push(`${short(t.output)} 输出`);
  return parts.join(' + ') || '0';
}

function short(n: number): string {
  if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(0) + 'K';
  return String(n);
}

export { rawTotal };
