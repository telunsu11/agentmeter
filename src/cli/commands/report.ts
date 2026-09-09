import { CliContext } from '../context.js';
import { flagString, flagNumber } from '../args.js';
import {
  filterEvents, groupByDay, groupByMonth, groupByModel, totalsOf, weightedTotal, rawTotal, evTokens,
} from '../../core/aggregate.js';
import { dateKeyToUtc, dayKey, monthKey } from '../../core/util.js';
import { UsageEvent } from '../../core/model.js';
import { CostCalculator } from '../../core/cost.js';
import { C, fmtNum, fmtTokens, fmtUsd, renderTable, bar, colorForAgent, padVisual, totalsBreakdown } from '../format.js';

/**
 * today / week / month 报告
 * - today：今天汇总（agent × model 细分 + 与昨日对比）
 * - week / month：逐日/逐月表格
 * - --cost：附加成本估算列（公开牌价 × token，订阅制用户仅供参考）
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
  const costCalc = flags['cost'] === true ? new CostCalculator(ctx.config) : undefined;

  if (flags['json']) {
    outputJson(ctx, cmd, filtered, tz, range, totals, costCalc);
    return;
  }

  printHeader(ctx, cmd, range, filtered.length);

  const costSummary = costCalc && filtered.length > 0 ? costCalc.costOfEvents(filtered) : undefined;
  if (cmd === 'today' || cmd === 'month' || cmd === 'week') {
    // 总量行
    const costPart = costSummary
      ? `  ·  ${C.yellow('≈' + fmtUsd(costSummary.known))}${costSummary.unknownTokens > 0 ? C.dim('(部分模型无牌价)') : ''}`
      : '';
    console.log(C.bold(`总计`) + `  ${C.cyan(fmtTokens(weightedTotal(totals)))} (加权)` +
      C.dim(`  raw ${fmtTokens(rawTotal(totals))}  ·  ${fmtNum(filtered.length)} 次请求`) + costPart);
    console.log(C.dim(`     ${totalsBreakdown(totals)}`));
    console.log();
  }

  if (filtered.length === 0) {
    console.log(C.dim('该时间范围内没有用量数据。'));
    console.log(C.dim('提示：agentmeter sources 可查看各数据源是否被检测到。'));
    return;
  }

  if (cmd === 'today') {
    printTodayDetail(ctx, filtered, tz, costCalc);
  } else if (cmd === 'week') {
    printDayTable(ctx, filtered, tz, costCalc);
  } else {
    printMonthTable(ctx, filtered, tz, costCalc);
  }
  if (costCalc) console.log(C.dim('\n成本为公开牌价估算（pricing/defaults.json，可在配置 pricing 段覆盖）；订阅制用户以配额消耗为准。'));
}

function outputJson(
  ctx: CliContext,
  cmd: string,
  events: UsageEvent[],
  tz: string,
  range: { since?: string; until?: string },
  totals: ReturnType<typeof totalsOf>,
  costCalc?: CostCalculator,
): void {
  const costAll = costCalc ? costCalc.costOfEvents(events) : undefined;
  const base: any = {
    command: cmd,
    range,
    tz,
    events: events.length,
    totals,
    weightedTotal: weightedTotal(totals),
    ...(costAll ? { costEstUsd: r2(costAll.known), costUnknownTokens: costAll.unknownTokens } : {}),
  };
  if (cmd === 'today') {
    base.byAgent = Object.fromEntries(
      [...new Set(events.map((e) => e.agent))].map((a) => [a, totalsOf(events.filter((e) => e.agent === a))]),
    );
    base.byModel = groupByModel(events).map((m) => ({
      model: m.model,
      events: m.events,
      totals: m.totals,
      ...(costCalc ? { costEstUsd: r2(costCalc.costOfEvents(events.filter((e) => e.model === m.model)).known) } : {}),
    }));
  } else if (cmd === 'week') {
    base.days = groupByDay(events, tz).map((d) => ({
      day: d.key,
      events: d.events,
      totals: d.totals,
      byAgent: d.byAgent,
      ...(costCalc ? { costEstUsd: r2(costCalc.costOfEvents(events.filter((e) => dayKey(e.ts, tz) === d.key)).known) } : {}),
    }));
  } else {
    base.months = groupByMonth(events, tz).map((m) => ({
      month: m.key,
      events: m.events,
      totals: m.totals,
      ...(costCalc ? { costEstUsd: r2(costCalc.costOfEvents(events.filter((e) => monthKey(e.ts, tz) === m.key)).known) } : {}),
    }));
  }
  console.log(JSON.stringify(base, null, 2));
}

function r2(n: number): number {
  return Math.round(n * 100) / 100;
}

function printHeader(ctx: CliContext, cmd: string, range: { since?: string; until?: string }, n: number): void {
  const title = cmd === 'today' ? '今日用量' : cmd === 'week' ? '近 7 天用量' : '月度用量';
  const scope = range.since && range.until ? `${range.since} ~ ${range.until}` : range.since ? `≥ ${range.since}` : '';
  console.log(C.bold(C.blue(`⚡ agentmeter · ${title}`)) + C.dim(`   ${scope}   tz=${ctx.tz}   解析 ${n} 条`));
  console.log();
}

function printTodayDetail(ctx: CliContext, events: UsageEvent[], tz: string, costCalc?: CostCalculator): void {
  // 按 agent 汇总
  const byAgent = new Map<string, { total: number; n: number; t: ReturnType<typeof totalsOf>; evts: UsageEvent[] }>();
  for (const e of events) {
    let b = byAgent.get(e.agent);
    if (!b) {
      b = { total: 0, n: 0, t: totalsOf([]), evts: [] };
      byAgent.set(e.agent, b);
    }
    b.total += weightedTotal(evTokens(e));
    b.n++;
    b.t = addT(b.t, evTokens(e));
    b.evts.push(e);
  }
  const maxAgent = Math.max(0, ...[...byAgent.values()].map((b) => b.total));
  console.log(C.bold('按 agent'));
  const agentRows = [...byAgent.entries()]
    .sort((a, b) => b[1].total - a[1].total)
    .map(([agent, b]) => {
      const row = [
        colorForAgent(agent)(agent),
        bar(b.total, maxAgent, 14),
        fmtTokens(b.total),
        fmtNum(b.n),
        fmtTokens(b.t.output),
      ];
      if (costCalc) row.push(costLabel(costCalc.costOfEvents(b.evts).known));
      return row;
    });
  const agentCols: import('../format.js').Column[] = [
    { header: 'agent' }, { header: '' }, { header: '加权', align: 'right' },
    { header: '请求', align: 'right' }, { header: '输出', align: 'right' },
  ];
  if (costCalc) agentCols.push({ header: '成本≈', align: 'right' });
  console.log(renderTable(agentCols, agentRows));
  console.log();

  // 按 model
  const models = groupByModel(events).slice(0, 12);
  const maxModel = Math.max(0, ...models.map((m) => weightedTotal(m.totals)));
  console.log(C.bold('按 model'));
  const modelRows = models.map((m) => {
    const row = [
      m.model,
      bar(weightedTotal(m.totals), maxModel, 12),
      fmtTokens(weightedTotal(m.totals)),
      fmtTokens(m.totals.input + m.totals.cacheRead),
      fmtTokens(m.totals.output),
      fmtNum(m.events),
    ];
    if (costCalc) row.push(costLabel(costCalc.costOfEvents(events.filter((e) => e.model === m.model)).known));
    return row;
  });
  const modelCols: import('../format.js').Column[] = [
    { header: 'model' }, { header: '' }, { header: '加权', align: 'right' },
    { header: '输入', align: 'right' }, { header: '输出', align: 'right' }, { header: '请求', align: 'right' },
  ];
  if (costCalc) modelCols.push({ header: '成本≈', align: 'right' });
  console.log(renderTable(modelCols, modelRows));
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

function printDayTable(ctx: CliContext, events: UsageEvent[], tz: string, costCalc?: CostCalculator): void {
  const days = groupByDay(events, tz);
  const max = Math.max(0, ...days.map((d) => weightedTotal(d.totals)));
  const rows = days.map((d) => {
    const row = [
      d.key,
      bar(weightedTotal(d.totals), max, 14),
      fmtTokens(weightedTotal(d.totals)),
      fmtTokens(d.totals.input + d.totals.cacheRead),
      fmtTokens(d.totals.output),
      fmtTokens(d.totals.cacheRead),
      fmtNum(d.events),
      Object.keys(d.byAgent).length > 0
        ? Object.entries(d.byAgent).map(([a, t]) => colorForAgent(a)(`${a[0].toUpperCase()} ${fmtTokens(weightedTotal(t))}`)).join(' ')
        : '',
    ];
    if (costCalc) row.push(costLabel(costCalc.costOfEvents(events.filter((e) => dayKey(e.ts, tz) === d.key)).known));
    return row;
  });
  const cols: import('../format.js').Column[] = [
    { header: '日期' }, { header: '' }, { header: '加权', align: 'right' },
    { header: '输入', align: 'right' }, { header: '输出', align: 'right' },
    { header: '缓存读', align: 'right' }, { header: '请求', align: 'right' }, { header: 'agents' },
  ];
  if (costCalc) cols.push({ header: '成本≈', align: 'right' });
  console.log(renderTable(cols, rows));
}

function printMonthTable(ctx: CliContext, events: UsageEvent[], tz: string, costCalc?: CostCalculator): void {
  const months = groupByMonth(events, tz);
  const max = Math.max(0, ...months.map((m) => weightedTotal(m.totals)));
  const rows = months.map((m) => {
    const row = [
      m.key,
      bar(weightedTotal(m.totals), max, 14),
      fmtTokens(weightedTotal(m.totals)),
      fmtTokens(m.totals.input + m.totals.cacheRead),
      fmtTokens(m.totals.output),
      fmtTokens(m.totals.cacheRead),
      fmtNum(m.events),
    ];
    if (costCalc) row.push(costLabel(costCalc.costOfEvents(events.filter((e) => monthKey(e.ts, tz) === m.key)).known));
    return row;
  });
  const cols: import('../format.js').Column[] = [
    { header: '月份' }, { header: '' }, { header: '加权', align: 'right' },
    { header: '输入', align: 'right' }, { header: '输出', align: 'right' },
    { header: '缓存读', align: 'right' }, { header: '请求', align: 'right' },
  ];
  if (costCalc) cols.push({ header: '成本≈', align: 'right' });
  console.log(renderTable(cols, rows));
  console.log();

  // 本月（或最新月份）agent 细分
  const latest = months[months.length - 1];
  if (latest) {
    const monthEvents = events.filter((e) => monthKey(e.ts, tz) === latest.key);
    console.log(C.bold(`${latest.key} 按 agent`));
    const byAgent = new Map<string, number>();
    for (const e of monthEvents) byAgent.set(e.agent, (byAgent.get(e.agent) || 0) + weightedTotal(evTokens(e)));
    for (const [agent, v] of [...byAgent.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${colorForAgent(agent)(padVisual(agent, 9))} ${fmtTokens(v)}`);
    }
  }
}

/** 成本单元格：无牌价模型的桶显示 — */
function costLabel(usd: number): string {
  return usd > 0 ? fmtUsd(usd) : '—';
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
