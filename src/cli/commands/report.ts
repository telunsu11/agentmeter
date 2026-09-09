import { CliContext } from '../context.js';
import { flagString, flagNumber } from '../args.js';
import {
  filterEvents, groupByDay, groupByMonth, groupByModel, totalsOf, weightedTotal, rawTotal, evTokens,
} from '../../core/aggregate.js';
import { dateKeyToUtc, dayKey } from '../../core/util.js';
import { UsageEvent } from '../../core/model.js';
import { C, fmtNum, fmtTokens, renderTable, bar, colorForAgent, totalsBreakdown } from '../format.js';

/**
 * today / week / month 报告
 * - today：今天汇总（agent × model 细分 + 与昨天对比）
 * - week / month：逐日/逐月表格
 */

export async function runReportCommand(ctx: CliContext, cmd: string, flags: Record<string, string | boolean>): Promise<void> {
  const { events, tz } = ctx;
  const since = flagString(flags, 'since');
  const until = flagString(flags, 'until');
  const last = flagNumber(flags, 'last');

  const range = resolveRange(cmd, tz, { since, until, last });
  const filtered = filterEvents(events, {
    since: range.since,
    until: range.until,
    agent: undefined,
    tz,
  }).sort((a, b) => a.ts.localeCompare(b.ts));

  const totals = totalsOf(filtered);

  if (flags['json']) {
    outputJson(ctx, cmd, filtered, tz, range, totals);
    return;
  }

  printHeader(ctx, cmd, range, filtered.length);

  if (cmd === 'today' || cmd === 'month' || cmd === 'week') {
    // 总量行
    console.log(C.bold(`总计`) + `  ${C.cyan(fmtTokens(weightedTotal(totals)))} (加权)` +
      C.dim(`  raw ${fmtTokens(rawTotal(totals))}  ·  ${fmtNum(filtered.length)} 次请求`));
    console.log(C.dim(`     ${totalsBreakdown(totals)}`));
    console.log();
  }

  if (filtered.length === 0) {
    console.log(C.dim('该时间范围内没有用量数据。'));
    console.log(C.dim('提示：agentmeter sources 可查看各数据源是否被检测到。'));
    return;
  }

  if (cmd === 'today') {
    printTodayDetail(ctx, filtered, tz);
  } else if (cmd === 'week') {
    printDayTable(ctx, filtered, tz);
  } else {
    printMonthTable(ctx, filtered, tz);
  }
}

function outputJson(
  ctx: CliContext,
  cmd: string,
  events: UsageEvent[],
  tz: string,
  range: { since?: string; until?: string },
  totals: ReturnType<typeof totalsOf>,
): void {
  const base: any = {
    command: cmd,
    range,
    tz,
    events: events.length,
    totals,
    weightedTotal: weightedTotal(totals),
  };
  if (cmd === 'today') {
    base.byAgent = Object.fromEntries(
      [...new Set(events.map((e) => e.agent))].map((a) => [a, totalsOf(events.filter((e) => e.agent === a))]),
    );
    base.byModel = groupByModel(events).map((m) => ({ model: m.model, events: m.events, totals: m.totals }));
  } else if (cmd === 'week') {
    base.days = groupByDay(events, tz).map((d) => ({ day: d.key, events: d.events, totals: d.totals, byAgent: d.byAgent }));
  } else {
    base.months = groupByMonth(events, tz).map((m) => ({ month: m.key, events: m.events, totals: m.totals }));
  }
  console.log(JSON.stringify(base, null, 2));
}

function printHeader(ctx: CliContext, cmd: string, range: { since?: string; until?: string }, n: number): void {  const title = cmd === 'today' ? '今日用量' : cmd === 'week' ? '近 7 天用量' : '月度用量';
  const scope = range.since && range.until ? `${range.since} ~ ${range.until}` : range.since ? `≥ ${range.since}` : '';
  console.log(C.bold(C.blue(`⚡ agentmeter · ${title}`)) + C.dim(`   ${scope}   tz=${ctx.tz}   解析 ${n} 条`));
  console.log();
}

function printTodayDetail(ctx: CliContext, events: UsageEvent[], tz: string): void {
  // 按 agent 汇总
  const byAgent = new Map<string, { total: number; n: number; t: ReturnType<typeof totalsOf> }>();
  for (const e of events) {
    let b = byAgent.get(e.agent);
    if (!b) {
      b = { total: 0, n: 0, t: totalsOf([]) };
      byAgent.set(e.agent, b);
    }
    b.total += weightedTotal(evTokens(e));
    b.n++;
    b.t = addT(b.t, evTokens(e));
  }
  const maxAgent = Math.max(0, ...[...byAgent.values()].map((b) => b.total));
  console.log(C.bold('按 agent'));
  const agentRows = [...byAgent.entries()]
    .sort((a, b) => b[1].total - a[1].total)
    .map(([agent, b]) => [
      colorForAgent(agent)(agent),
      bar(b.total, maxAgent, 14),
      fmtTokens(b.total),
      fmtNum(b.n),
      fmtTokens(b.t.output),
    ]);
  console.log(renderTable(
    [
      { header: 'agent' }, { header: '' }, { header: '加权', align: 'right' },
      { header: '请求', align: 'right' }, { header: '输出', align: 'right' },
    ],
    agentRows,
  ));
  console.log();

  // 按 model
  const models = groupByModel(events).slice(0, 12);
  const maxModel = Math.max(0, ...models.map((m) => weightedTotal(m.totals)));
  console.log(C.bold('按 model'));
  console.log(renderTable(
    [
      { header: 'model' }, { header: '' }, { header: '加权', align: 'right' },
      { header: '输入', align: 'right' }, { header: '输出', align: 'right' }, { header: '请求', align: 'right' },
    ],
    models.map((m) => [
      m.model,
      bar(weightedTotal(m.totals), maxModel, 12),
      fmtTokens(weightedTotal(m.totals)),
      fmtTokens(m.totals.input + m.totals.cacheRead),
      fmtTokens(m.totals.output),
      fmtNum(m.events),
    ]),
  ));
  console.log();

  // 对比昨天
  const todayKey = dayKey(new Date().toISOString(), tz);
  const yKey = shiftDay(todayKey, -1);
  const yEvents = ctx.events.filter((e) => dayKey(e.ts, tz) === yKey);
  const yTotals = totalsOf(yEvents);
  const cur = weightedTotal(totalsOf(events));
  const y = weightedTotal(yTotals);
  if (y > 0) {
    const ratio = cur / y;
    const arrow = ratio >= 1.15 ? '↑' : ratio <= 0.85 ? '↓' : '≈';
    const col = ratio >= 1.15 ? C.red : ratio <= 0.85 ? C.green : C.yellow;
    console.log(`昨日同期口径 ${C.dim(fmtTokens(y))}  →  今天 ${arrow} ${col(fmtTokens(cur))} (${(ratio * 100).toFixed(0)}%)`);
  }
}

function printDayTable(ctx: CliContext, events: UsageEvent[], tz: string): void {
  const days = groupByDay(events, tz);
  const max = Math.max(0, ...days.map((d) => weightedTotal(d.totals)));
  console.log(renderTable(
    [
      { header: '日期' }, { header: '' }, { header: '加权', align: 'right' },
      { header: '输入', align: 'right' }, { header: '输出', align: 'right' },
      { header: '缓存读', align: 'right' }, { header: '请求', align: 'right' }, { header: 'agents' },
    ],
    days.map((d) => [
      d.key,
      bar(weightedTotal(d.totals), max, 14),
      fmtTokens(weightedTotal(d.totals)),
      fmtTokens(d.totals.input + d.totals.cacheRead),
      fmtTokens(d.totals.output),
      fmtTokens(d.totals.cacheRead),
      fmtNum(d.events),
      Object.keys(d.byAgent).map(colorForAgent).length > 0
        ? Object.entries(d.byAgent).map(([a, t]) => colorForAgent(a)(`${a[0].toUpperCase()} ${fmtTokens(weightedTotal(t))}`)).join(' ')
        : '',
    ]),
  ));
}

function printMonthTable(ctx: CliContext, events: UsageEvent[], tz: string): void {
  const months = groupByMonth(events, tz);
  const max = Math.max(0, ...months.map((m) => weightedTotal(m.totals)));
  console.log(renderTable(
    [
      { header: '月份' }, { header: '' }, { header: '加权', align: 'right' },
      { header: '输入', align: 'right' }, { header: '输出', align: 'right' },
      { header: '缓存读', align: 'right' }, { header: '请求', align: 'right' },
    ],
    months.map((m) => [
      m.key,
      bar(weightedTotal(m.totals), max, 14),
      fmtTokens(weightedTotal(m.totals)),
      fmtTokens(m.totals.input + m.totals.cacheRead),
      fmtTokens(m.totals.output),
      fmtTokens(m.totals.cacheRead),
      fmtNum(m.events),
    ]),
  ));
  console.log();

  // 本月（或最新月份）agent 细分
  const latest = months[months.length - 1];
  if (latest) {
    const monthEvents = events.filter((e) => dayKey(e.ts, tz).slice(0, 7) === latest.key);
    console.log(C.bold(`${latest.key} 按 agent`));
    const byAgent = new Map<string, number>();
    for (const e of monthEvents) byAgent.set(e.agent, (byAgent.get(e.agent) || 0) + weightedTotal(evTokens(e)));
    for (const [agent, v] of [...byAgent.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${colorForAgent(agent)(agent.padEnd(9))} ${fmtTokens(v)}`);
    }
  }
}

function addT(a: ReturnType<typeof totalsOf>, b: ReturnType<typeof totalsOf>): ReturnType<typeof totalsOf> {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
  };
}

interface RangeSpec {
  since?: string;
  until?: string;
}

function resolveRange(cmd: string, tz: string, opts: { since?: string; until?: string; last?: number }): RangeSpec {
  if (opts.since || opts.until) return { since: opts.since, until: opts.until };
  const today = dayKey(new Date().toISOString(), tz);
  if (cmd === 'today') return { since: today, until: today };
  if (cmd === 'week') {
    const n = opts.last || 7;
    return { since: shiftDay(today, -(n - 1)), until: today };
  }
  // month：默认显示全部月份；--last N 只看最近 N 个月
  if (opts.last) return { since: shiftMonth(today, -(opts.last - 1)) };
  return {};
}

function shiftDay(day: string, delta: number): string {
  const t = dateKeyToUtc(day, 'UTC') + delta * 86400_000;
  return new Date(t).toISOString().slice(0, 10);
}

function shiftMonth(day: string, delta: number): string {
  const [y, m] = day.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return d.toISOString().slice(0, 10);
}
