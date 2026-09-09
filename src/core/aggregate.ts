import { AgentId, TokenTotals, UsageEvent, ZERO_TOTALS, addTokens } from './model.js';
import { dayKey, monthKey } from './util.js';

export interface RangeFilter {
  since?: string; // YYYY-MM-DD（按 tz 的本地日期）
  until?: string; // YYYY-MM-DD（含）
  agent?: AgentId[];
  project?: string; // 子串匹配
  /** 日期归属时区；缺省 UTC */
  tz?: string;
}

export function filterEvents(events: UsageEvent[], f: RangeFilter): UsageEvent[] {
  const tz = f.tz || 'UTC';
  return events.filter((e) => {
    if (f.agent && f.agent.length && !f.agent.includes(e.agent)) return false;
    if (f.project && !e.projectDir.includes(f.project)) return false;
    // 与报表口径一致：按本地时区判定事件属于哪一天
    const day = dayKey(e.ts, tz);
    if (f.since && day < f.since) return false;
    if (f.until && day > f.until) return false;
    return true;
  });
}

export function totalsOf(events: UsageEvent[]): TokenTotals {
  let t = ZERO_TOTALS;
  for (const e of events) {
    t = addTokens(t, {
      input: e.inputTokens,
      output: e.outputTokens,
      cacheRead: e.cacheReadTokens,
      cacheWrite: e.cacheWriteTokens,
    });
  }
  return t;
}

/** "总 token"口径：cache 读按 1/10 折算（贴近真实成本权重），其余全算 */
export function weightedTotal(t: TokenTotals): number {
  return t.input + t.output + t.cacheWrite + Math.round(t.cacheRead / 10);
}

export function rawTotal(t: TokenTotals): number {
  return t.input + t.output + t.cacheRead + t.cacheWrite;
}

export interface DayBucket {
  key: string; // YYYY-MM-DD
  totals: TokenTotals;
  events: number;
  byAgent: Record<string, TokenTotals>;
}

export function groupByDay(events: UsageEvent[], tz: string): DayBucket[] {
  const map = new Map<string, DayBucket>();
  for (const e of events) {
    const key = dayKey(e.ts, tz);
    let b = map.get(key);
    if (!b) {
      b = { key, totals: { ...ZERO_TOTALS }, events: 0, byAgent: {} };
      map.set(key, b);
    }
    b.totals = addTokens(b.totals, evTokens(e));
    b.events++;
    b.byAgent[e.agent] = addTokens(b.byAgent[e.agent] || ZERO_TOTALS, evTokens(e));
  }
  return [...map.values()].sort((a, b) => a.key.localeCompare(b.key));
}

export interface MonthBucket {
  key: string; // YYYY-MM
  totals: TokenTotals;
  events: number;
}

export function groupByMonth(events: UsageEvent[], tz: string): MonthBucket[] {
  const map = new Map<string, MonthBucket>();
  for (const e of events) {
    const key = monthKey(e.ts, tz);
    let b = map.get(key);
    if (!b) {
      b = { key, totals: { ...ZERO_TOTALS }, events: 0 };
      map.set(key, b);
    }
    b.totals = addTokens(b.totals, evTokens(e));
    b.events++;
  }
  return [...map.values()].sort((a, b) => a.key.localeCompare(b.key));
}

export interface ProjectBucket {
  projectDir: string;
  totals: TokenTotals;
  events: number;
  sessions: Set<string>;
  agents: Set<AgentId>;
  lastTs: string;
}

export function groupByProject(events: UsageEvent[]): ProjectBucket[] {
  const map = new Map<string, ProjectBucket>();
  for (const e of events) {
    const dir = e.projectDir || '(unknown)';
    let b = map.get(dir);
    if (!b) {
      b = { projectDir: dir, totals: { ...ZERO_TOTALS }, events: 0, sessions: new Set(), agents: new Set(), lastTs: '' };
      map.set(dir, b);
    }
    b.totals = addTokens(b.totals, evTokens(e));
    b.events++;
    b.sessions.add(e.sessionId);
    b.agents.add(e.agent);
    if (e.ts > b.lastTs) b.lastTs = e.ts;
  }
  return [...map.values()].sort((a, b) => rawTotal(b.totals) - rawTotal(a.totals));
}

export interface SessionBucket {
  agent: AgentId;
  sessionId: string;
  projectDir: string;
  totals: TokenTotals;
  events: number;
  firstTs: string;
  lastTs: string;
  models: Set<string>;
  apiErrors: number;
}

export function groupBySession(events: UsageEvent[]): SessionBucket[] {
  const map = new Map<string, SessionBucket>();
  for (const e of events) {
    const key = `${e.agent}:${e.sessionId}`;
    let b = map.get(key);
    if (!b) {
      b = {
        agent: e.agent,
        sessionId: e.sessionId,
        projectDir: e.projectDir || '(unknown)',
        totals: { ...ZERO_TOTALS },
        events: 0,
        firstTs: e.ts,
        lastTs: e.ts,
        models: new Set(),
        apiErrors: 0,
      };
      map.set(key, b);
    }
    b.totals = addTokens(b.totals, evTokens(e));
    b.events++;
    if (e.ts < b.firstTs) b.firstTs = e.ts;
    if (e.ts > b.lastTs) b.lastTs = e.ts;
    b.models.add(e.model);
    if (e.meta?.isApiError) b.apiErrors++;
  }
  return [...map.values()].sort((a, b) => rawTotal(b.totals) - rawTotal(a.totals));
}

export function groupByModel(events: UsageEvent[]): { model: string; totals: TokenTotals; events: number }[] {
  const map = new Map<string, { model: string; totals: TokenTotals; events: number }>();
  for (const e of events) {
    let b = map.get(e.model);
    if (!b) {
      b = { model: e.model, totals: { ...ZERO_TOTALS }, events: 0 };
      map.set(e.model, b);
    }
    b.totals = addTokens(b.totals, evTokens(e));
    b.events++;
  }
  return [...map.values()].sort((a, b) => rawTotal(b.totals) - rawTotal(a.totals));
}

export function evTokens(e: UsageEvent): TokenTotals {
  return {
    input: e.inputTokens,
    output: e.outputTokens,
    cacheRead: e.cacheReadTokens,
    cacheWrite: e.cacheWriteTokens,
  };
}
