import { CliContext } from '../context.js';
import { QuotaStatus, fmtQuotaReset, quotaStatus as computeQuotaStatus } from '../../core/quota.js';
import { C, fmtNum, fmtTokens, renderTable } from '../format.js';

/** quota：配额窗口使用情况。需要先在 agentmeter.json 配置 quotas。 */

export function quotaStatus(ctx: CliContext, now: Date): QuotaStatus[] {
  return computeQuotaStatus(ctx.events, ctx.config, ctx.tz, now);
}

export async function runQuotaCommand(ctx: CliContext, flags: Record<string, string | boolean>): Promise<void> {
  const now = new Date();
  const statuses = quotaStatus(ctx, now);

  if (flags['json']) {
    console.log(JSON.stringify({ quotas: statuses }, null, 2));
    return;
  }

  console.log(C.bold(C.blue('⚡ agentmeter · 配额窗口')));
  console.log();

  if (statuses.length === 0) {
    console.log(C.yellow('还没有配置任何配额限额。'));
    console.log();
    console.log('在项目目录或 ~/.config/agentmeter/config.json 里配置，例如：');
    console.log(C.dim(JSON.stringify(
      { quotas: { claude: { windows: [{ type: 'rolling', hours: 5, limitTokens: 44000000 }] } } },
      null,
      2,
    )));
    console.log('\n完整示例：agentmeter config init');
    return;
  }

  const rows = statuses.map((s) => {
    const pctStr = s.limitTokens || s.limitTurns ? Math.round(s.pct * 100) + '%' : '—';
    const pctColored =
      s.pct >= 0.95 ? C.red(pctStr) : s.pct >= 0.8 ? C.yellow(pctStr) : C.green(pctStr);
    return [
      s.agent,
      s.windowDesc,
      fmtTokens(s.used),
      s.limitTokens ? fmtTokens(s.limitTokens) : s.limitTurns ? `${fmtNum(s.usedTurns)}/${fmtNum(s.limitTurns)} 轮` : '—',
      pctColored,
      fmtQuotaReset(s.resetsAt, now),
    ];
  });
  console.log(
    renderTable(
      [
        { header: 'agent' },
        { header: '窗口' },
        { header: '已用(加权)', align: 'right' },
        { header: '限额', align: 'right' },
        { header: '进度', align: 'right' },
        { header: '重置' },
      ],
      rows,
    ),
  );
  console.log(C.dim('\n用量口径：加权 token（缓存读按 1/10 折算）。配置限额时建议参考官方配额文档。'));
}
