import { AgentId, AgentMeterConfig, UsageEvent } from './model.js';
import { totalsOf, weightedTotal, rawTotal } from './aggregate.js';
import { dateKeyToUtc, dayKey } from './util.js';

/**
 * 配额窗口模型：rolling / daily / weekly / monthly。
 * 用量口径：weightedTotal（cache 读按 1/10 折算），与报告主数字一致。
 * limitTurns 支持按请求次数限额（Claude Max 风格）。
 */

export interface QuotaStatus {
  agent: AgentId;
  label: string;
  windowDesc: string;
  used: number;
  limitTokens?: number;
  usedTurns: number;
  limitTurns?: number;
  pct: number;
  /** 窗口重置时间（滚动窗口为 null） */
  resetsAt: string | null;
}

export function quotaStatus(
  events: UsageEvent[],
  config: AgentMeterConfig,
  tz: string,
  now: Date,
): QuotaStatus[] {
  const out: QuotaStatus[] = [];
  const quotas = config.quotas || {};
  const nowMs = now.getTime();

  for (const [agentId, q] of Object.entries(quotas) as [AgentId, { windows: any[] }][]) {
    if (!q?.windows?.length) continue;
    const agentEvents = events.filter((e) => e.agent === agentId);
    for (const w of q.windows) {
      const bounds = windowBounds(w, tz, nowMs);
      const inWindow = agentEvents.filter((e) => {
        const t = Date.parse(e.ts);
        return t >= bounds.fromMs && t <= nowMs;
      });
      const used = weightedTotal(totalsOf(inWindow));
      const limitTokens = typeof w.limitTokens === 'number' ? w.limitTokens : undefined;
      const limitTurns = typeof w.limitTurns === 'number' ? w.limitTurns : undefined;
      const denom = limitTokens ?? (limitTurns ? (used / Math.max(1, inWindow.length)) * limitTurns : undefined);
      out.push({
        agent: agentId,
        label: windowLabel(w, agentId),
        windowDesc: bounds.desc,
        used,
        limitTokens,
        usedTurns: inWindow.length,
        limitTurns,
        pct: denom ? Math.min(used / denom, 9.99) : 0,
        resetsAt: bounds.resetsAtIso,
      });
    }
  }
  return out;
}

function windowLabel(w: any, agent: string): string {
  switch (w.type) {
    case 'rolling': return `${agent} ${w.hours || 5}h`;
    case 'daily': return `${agent} 日`;
    case 'weekly': return `${agent} 周`;
    case 'monthly': return `${agent} 月`;
    default: return agent;
  }
}

function windowBounds(w: any, tz: string, nowMs: number): { fromMs: number; desc: string; resetsAtIso: string | null } {
  const nowKey = dayKey(new Date(nowMs).toISOString(), tz);
  const todayStart = dateKeyToUtc(nowKey, tz);
  const d = new Date(nowMs);

  switch (w.type) {
    case 'rolling': {
      const hours = (w.hours || 5) * 3600_000;
      return { fromMs: nowMs - hours, desc: `滚动 ${w.hours || 5}h`, resetsAtIso: null };
    }
    case 'daily':
      return { fromMs: todayStart, desc: '自然日', resetsAtIso: iso(todayStart + 86400_000) };
    case 'weekly': {
      const weekday = weekdayOf(nowKey, tz); // 0=周一
      const mondayStart = todayStart - weekday * 86400_000;
      return { fromMs: mondayStart, desc: '自然周(周一起)', resetsAtIso: iso(mondayStart + 7 * 86400_000) };
    }
    case 'monthly': {
      const ym = nowKey.slice(0, 7);
      const [y, m] = ym.split('-').map(Number);
      const monthStart = dateKeyToUtc(`${y}-${String(m).padStart(2, '0')}-01`, tz);
      const nextY = m === 12 ? y + 1 : y;
      const nextM = m === 12 ? 1 : m + 1;
      const nextStart = dateKeyToUtc(`${nextY}-${String(nextM).padStart(2, '0')}-01`, tz);
      return { fromMs: monthStart, desc: '自然月', resetsAtIso: iso(nextStart) };
    }
    default:
      return { fromMs: 0, desc: '?', resetsAtIso: null };
  }

  function iso(ms: number): string {
    return new Date(ms).toISOString();
  }

  function weekdayOf(key: string, tzName: string): number {
    // ISO weekday（周一=0）：通过 en-US weekday 名映射
    const names = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
    const fmt = new Intl.DateTimeFormat('en-US', { timeZone: tzName, weekday: 'long' });
    const name = fmt.format(new Date(dateKeyToUtc(key, tzName) + 12 * 3600_000));
    return Math.max(0, names.indexOf(name));
  }
}

export function fmtQuotaReset(resetsAtIso: string | null, now: Date): string {
  if (!resetsAtIso) return '—';
  const ms = Date.parse(resetsAtIso) - now.getTime();
  if (ms <= 0) return '已重置';
  const h = Math.floor(ms / 3600_000);
  const m = Math.floor((ms % 3600_000) / 60000);
  return h > 0 ? `${h}h${m}m` : `${m}m`;
}

export { rawTotal };
