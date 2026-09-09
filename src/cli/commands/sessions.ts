import { CliContext } from '../context.js';
import { flagNumber, flagString } from '../args.js';
import { filterEvents, groupBySession, rawTotal } from '../../core/aggregate.js';
import { C, colorForAgent, fmtNum, fmtTokens, renderTable, bar, shortenDir } from '../format.js';

/** sessions：会话级明细，默认按 token 降序 Top 20 */
export async function runSessionsCommand(ctx: CliContext, flags: Record<string, string | boolean>): Promise<void> {
  const since = flagString(flags, 'since');
  const until = flagString(flags, 'until');
  const top = flagNumber(flags, 'top') || 20;
  const filtered = filterEvents(ctx.events, { since, until, tz: ctx.tz });
  const sessions = groupBySession(filtered);

  if (flags['json']) {
    console.log(
      JSON.stringify(
        {
          sessions: sessions.slice(0, top).map((s) => ({
            agent: s.agent,
            sessionId: s.sessionId,
            project: s.projectDir,
            firstTs: s.firstTs,
            lastTs: s.lastTs,
            events: s.events,
            models: [...s.models],
            apiErrors: s.apiErrors,
            totals: s.totals,
          })),
        },
        null,
        2,
      ),
    );
    return;
  }

  console.log(C.bold(C.blue('⚡ agentmeter · 会话明细')));
  console.log(C.dim(`  ${since || '全部历史'}${until ? ` ~ ${until}` : ''}   共 ${sessions.length} 个会话，显示 Top ${Math.min(top, sessions.length)}`));
  console.log();

  if (sessions.length === 0) {
    console.log(C.dim('没有数据。'));
    return;
  }

  const max = Math.max(...sessions.map((s) => rawTotal(s.totals)));
  const rows = sessions.slice(0, top).map((s) => [
    colorForAgent(s.agent)(s.agent),
    s.sessionId.slice(0, 8),
    shortenDir(s.projectDir, 30),
    bar(rawTotal(s.totals), max, 10),
    fmtTokens(rawTotal(s.totals)),
    fmtNum(s.events),
    s.firstTs.slice(5, 16).replace('T', ' '),
    [...s.models].slice(0, 2).join(',').slice(0, 24),
    s.apiErrors > 0 ? C.red(String(s.apiErrors)) : '',
  ]);
  console.log(
    renderTable(
      [
        { header: 'agent' },
        { header: '会话' },
        { header: '项目' },
        { header: '' },
        { header: '总 token', align: 'right' },
        { header: '请求', align: 'right' },
        { header: '开始' },
        { header: 'model' },
        { header: 'API错误', align: 'right' },
      ],
      rows,
    ),
  );
  console.log(C.dim('\n会话文件位置可用 sources 命令查看；waste 命令定位无效会话。'));
}
