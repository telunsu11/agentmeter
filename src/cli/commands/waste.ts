import { CliContext } from '../context.js';
import { flagNumber, flagString } from '../args.js';
import { detectWaste, wasteTotals } from '../../core/waste/engine.js';
import { WasteFinding, WasteType } from '../../core/model.js';
import { filterEvents, rawTotal, totalsOf } from '../../core/aggregate.js';
import { C, colorForAgent, fmtTokens, renderTable, shortenDir } from '../format.js';

const TYPE_LABEL: Record<WasteType, string> = {
  api_retry: 'API 错误/重试',
  failure_loop: '失败循环',
  context_restart: '上下文重启',
  ineffective_cache: '缓存空转',
  zombie_session: '僵尸会话',
  duplicate_reads: '重复读取',
  context_bloat: '长会话税',
};

/** waste：浪费审计报告 */
export async function runWasteCommand(ctx: CliContext, flags: Record<string, string | boolean>): Promise<void> {
  const since = flagString(flags, 'since');
  const until = flagString(flags, 'until');
  const minTokens = flagNumber(flags, 'min-tokens') ?? ctx.config.waste?.minTokensToReport ?? 0;
  const typeFilter = flagString(flags, 'type')?.split(',').filter(Boolean) as WasteType[] | undefined;

  let findings = detectWaste(ctx.traces, ctx.config, since, until, ctx.tz);
  if (typeFilter?.length) findings = findings.filter((f) => typeFilter.includes(f.type));
  if (minTokens > 0) {
    findings = findings.filter((f) => rawTotal(f.tokensWasted) >= minTokens || f.type === 'duplicate_reads');
  }
  findings.sort((a, b) => rawTotal(b.tokensWasted) - rawTotal(a.tokensWasted));

  const inRange = filterEvents(ctx.events, { since, until, tz: ctx.tz });
  const scopeTotal = rawTotal(totalsOf(inRange));
  const { byType, grand } = wasteTotals(findings);

  if (flags['json']) {
    // 成本以 token 为一等公民：finding 不带模型信息，牌价折算不可信，故不输出成本字段
    console.log(
      JSON.stringify(
        {
          range: { since, until },
          totalTokens: scopeTotal,
          wasteEstTotal: grand,
          wasteRatio: scopeTotal > 0 ? rawTotal(grand) / scopeTotal : 0,
          byType: Object.fromEntries(
            (Object.keys(byType) as WasteType[]).map((t) => [t, { label: TYPE_LABEL[t], tokens: byType[t] }]),
          ),
          findings: findings.slice(0, 100),
        },
        null,
        2,
      ),
    );
    return;
  }

  console.log(C.bold(C.blue('⚡ agentmeter · 浪费审计')));
  console.log(C.dim(`  ${since || '全部历史'}${until ? ` ~ ${until}` : ''}   范围内总消耗 ${fmtTokens(scopeTotal)}`));
  console.log();

  if (findings.length === 0) {
    console.log(C.green('未检测到明显浪费信号 🎉'));
    console.log(C.dim('（各信号有阈值，少量重试/重复读取属于正常范围）'));
    return;
  }

  const ratio = scopeTotal > 0 ? rawTotal(grand) / scopeTotal : 0;
  const ratioColored = ratio > 0.3 ? C.red((ratio * 100).toFixed(1) + '%') : ratio > 0.1 ? C.yellow((ratio * 100).toFixed(1) + '%') : C.green((ratio * 100).toFixed(1) + '%');
  const wasteTotal = rawTotal(grand);
  const wasteColored = wasteTotal > 0 ? C.bold(C.red(fmtTokens(wasteTotal))) : C.dim(fmtTokens(wasteTotal));
  console.log(
    `估算浪费 ${wasteColored} token（约占 ${ratioColored}）`,
  );
  console.log(C.dim('口径：缓存读按原量计入浪费（对订阅制用户是真实配额）；各信号独立估算，可能相互重叠。'));
  console.log();

  // 按类型汇总
  console.log(C.bold('按浪费类型'));
  const typeRows = (Object.keys(byType) as WasteType[])
    .filter((t) => rawTotal(byType[t]) > 0 || findings.some((f) => f.type === t))
    .map((t) => {
      const fs2 = findings.filter((f) => f.type === t);
      return [
        TYPE_LABEL[t],
        String(fs2.length),
        rawTotal(byType[t]) > 0 ? fmtTokens(rawTotal(byType[t])) : '—',
        fmtTokens(byType[t].cacheRead),
        fs2.filter((f) => f.severity === 'high').length > 0 ? C.red('有') : '',
      ];
    });
  console.log(renderTable(
    [
      { header: '类型' },
      { header: '信号数', align: 'right' },
      { header: '浪费 token', align: 'right' },
      { header: '其中缓存读', align: 'right' },
      { header: '高危', align: 'right' },
    ],
    typeRows,
  ));
  console.log();

  // Top 发现
  const top = flagNumber(flags, 'top') ?? 15;
  console.log(C.bold(`Top 发现（${Math.min(top, findings.length)} 条，按浪费量排序）`));
  const rows = findings.slice(0, top).map((f) => [
    sevColor(f.severity)(f.severity),
    TYPE_LABEL[f.type],
    colorForAgent(f.agent)(f.agent),
    shortenDir(f.projectDir, 26),
    f.ts.slice(0, 16).replace('T', ' '),
    String(f.count),
    rawTotal(f.tokensWasted) > 0 ? fmtTokens(rawTotal(f.tokensWasted)) : '—',
  ]);
  console.log(renderTable(
    [
      { header: '置信' },
      { header: '类型' },
      { header: 'agent' },
      { header: '项目' },
      { header: '发生时间' },
      { header: '次数', align: 'right' },
      { header: '浪费', align: 'right' },
    ],
    rows,
  ));
  console.log();

  // 详情（前 5 条完整说明）
  console.log(C.bold('详情'));
  for (const f of findings.slice(0, 5)) {
    console.log(`  ${sevColor(f.severity)('●')} ${TYPE_LABEL[f.type]} · ${f.agent} · ${shortenDir(f.projectDir, 40)}`);
    console.log(`    ${C.dim(f.detail)}`);
    console.log(`    ${C.dim(`定位：${f.agent} 会话 ${f.sessionId.slice(0, 13)} · ${f.ts}`)}`);
  }
  if (findings.length > 5) console.log(C.dim(`  … 以及另外 ${findings.length - 5} 条（--top N 展开更多，--json 全量）`));
}

function sevColor(s: string): (x: string) => string {
  return s === 'high' ? C.red : s === 'medium' ? C.yellow : C.gray;
}
