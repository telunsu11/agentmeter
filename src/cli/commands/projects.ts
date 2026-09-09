import { CliContext } from '../context.js';
import { flagString } from '../args.js';
import { filterEvents, groupByProject, rawTotal } from '../../core/aggregate.js';
import { CostCalculator } from '../../core/cost.js';
import { C, fmtNum, fmtTokens, renderTable, bar, shortenDir, fmtUsd } from '../format.js';

/** projects：哪个项目最烧（按项目目录聚合） */
export async function runProjectsCommand(ctx: CliContext, flags: Record<string, string | boolean>): Promise<void> {
  const since = flagString(flags, 'since');
  const until = flagString(flags, 'until');
  const filtered = filterEvents(ctx.events, { since, until });
  const projects = groupByProject(filtered);
  const max = Math.max(0, ...projects.map((p) => rawTotal(p.totals)));
  const showCost = flags['cost'] === true;
  const costCalc = showCost ? new CostCalculator(ctx.config) : undefined;

  // 项目级成本：按事件逐条估算（项目可能混用多模型）
  const costByProject = new Map<string, { known: number; unknownTokens: number }>();
  if (costCalc) {
    for (const e of filtered) {
      const dir = e.projectDir || '(unknown)';
      const c = costCalc.costOfEvent(e);
      const agg = costByProject.get(dir) || { known: 0, unknownTokens: 0 };
      if (c === undefined) agg.unknownTokens += e.inputTokens + e.outputTokens + e.cacheReadTokens + e.cacheWriteTokens;
      else agg.known += c;
      costByProject.set(dir, agg);
    }
  }

  if (flags['json']) {
    console.log(
      JSON.stringify(
        {
          projects: projects.map((p) => ({
            project: p.projectDir,
            sessions: p.sessions.size,
            events: p.events,
            agents: [...p.agents],
            lastActive: p.lastTs,
            totals: p.totals,
            ...(showCost ? { costEstUsd: round2(costByProject.get(p.projectDir)?.known), unknownPriceTokens: costByProject.get(p.projectDir)?.unknownTokens } : {}),
          })),
        },
        null,
        2,
      ),
    );
    return;
  }

  console.log(C.bold(C.blue('⚡ agentmeter · 项目用量')));
  console.log(C.dim(`  ${since || '全部历史'}${until ? ` ~ ${until}` : ''}   共 ${projects.length} 个项目`));
  console.log();
  if (projects.length === 0) {
    console.log(C.dim('没有数据。'));
    return;
  }

  const rows = projects.slice(0, 30).map((p) => {
    const row = [
      shortenDir(p.projectDir),
      bar(rawTotal(p.totals), max, 12),
      fmtTokens(rawTotal(p.totals)),
      fmtNum(p.sessions.size),
      fmtNum(p.events),
      [...p.agents].map((a) => a[0].toUpperCase()).join(''),
      p.lastTs.slice(0, 10),
    ];
    if (showCost) {
      const c = costByProject.get(p.projectDir);
      row.push(c && c.known > 0 ? fmtUsd(c.known) : '—');
    }
    return row;
  });
  const cols: import('../format.js').Column[] = [
    { header: '项目' },
    { header: '' },
    { header: '总 token', align: 'right' },
    { header: '会话', align: 'right' },
    { header: '请求', align: 'right' },
    { header: 'A' },
    { header: '最近活跃' },
  ];
  if (showCost) cols.push({ header: '成本≈', align: 'right' });
  console.log(renderTable(cols, rows));
  if (showCost) console.log(C.dim('\n成本为公开牌价估算；订阅制用户实际以配额消耗为准。'));
}

function round2(n: number | undefined): number | undefined {
  return n === undefined ? undefined : Math.round(n * 100) / 100;
}
