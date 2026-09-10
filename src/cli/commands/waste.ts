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

/** 硬浪费：直接可避免的损失（重试、失败循环、僵尸会话的输入侧） */
const HARD_TYPES: WasteType[] = ['api_retry', 'failure_loop', 'zombie_session'];

/** Top 榜单每类信号最多展示条数：防止单一类型淹没其他更有行动价值的信号 */
const TOP_PER_TYPE = 3;

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
          hardWasteTotal: rawTotal(wasteTotals(findings.filter((f) => HARD_TYPES.includes(f.type))).grand),
          hardWasteRatio: scopeTotal > 0
            ? rawTotal(wasteTotals(findings.filter((f) => HARD_TYPES.includes(f.type))).grand) / scopeTotal
            : 0,
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

  // 双口径：先给可信的硬浪费，再给含缓存重读的完整口径
  const hard = wasteTotals(findings.filter((f) => HARD_TYPES.includes(f.type))).grand;
  const hardTotal = rawTotal(hard);
  const hardRatio = scopeTotal > 0 ? hardTotal / scopeTotal : 0;
  const fullTotal = rawTotal(grand);
  const fullRatio = scopeTotal > 0 ? fullTotal / scopeTotal : 0;
  const ratioColored = (r: number) =>
    r > 0.3 ? C.red((r * 100).toFixed(1) + '%') : r > 0.1 ? C.yellow((r * 100).toFixed(1) + '%') : C.green((r * 100).toFixed(1) + '%');
  console.log(
    `硬浪费   ${hardTotal > 0 ? C.bold(C.red(fmtTokens(hardTotal))) : C.green(fmtTokens(hardTotal))} token（约占 ${ratioColored(hardRatio)}）` +
    C.dim('  ← API 重试/失败循环/僵尸会话，直接可避免'),
  );
  console.log(
    `含重读   ${fullTotal > hardTotal ? C.yellow(fmtTokens(fullTotal)) : C.dim(fmtTokens(fullTotal))} token（约占 ${ratioColored(fullRatio)}）` +
    C.dim('  ← 加上缓存重读类（长会话税/空转/重启），可优化'),
  );
  console.log(C.dim('各信号独立估算，可能相互重叠；订阅制用户的缓存读是真实配额消耗。'));
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

  // Top 发现（每类最多 TOP_PER_TYPE 条，保证类型多样性）
  const top = flagNumber(flags, 'top') ?? 15;
  const diverse = (() => {
    const seen = new Map<WasteType, number>();
    return findings.filter((f) => {
      const n = seen.get(f.type) || 0;
      if (n >= TOP_PER_TYPE) return false;
      seen.set(f.type, n + 1);
      return true;
    });
  })();
  console.log(C.bold(`Top 发现（${Math.min(top, diverse.length)} 条，按浪费量排序，每类最多 ${TOP_PER_TYPE} 条）`));
  const rows = diverse.slice(0, top).map((f) => [
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
