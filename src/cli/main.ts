#!/usr/bin/env node
import { parseArgs } from './args.js';
import { buildContext } from './context.js';
import { runReportCommand } from './commands/report.js';
import { runSourcesCommand } from './commands/sources.js';

const HELP = `
⚡ agentmeter — coding agent 的电表 + 用电审计 + 跳闸预警
纯本地解析 Claude Code / ZCode / Codex / OpenCode 会话日志，零遥测。

用法：
  agentmeter                    今日用量（= today）
  agentmeter today              今日汇总：按 agent / model，对比昨日
  agentmeter week               近 7 天逐日用量
  agentmeter month              月度用量表
  agentmeter projects           哪个项目最烧
  agentmeter sessions           会话级明细（Top N）
  agentmeter waste              浪费审计：无效重试 / 失败循环 / 上下文重启…
  agentmeter quota              配额窗口使用情况；preset 一键写入套餐限额
  agentmeter watch              持续监控 + 配额预警通知；--once 单次检查
  agentmeter statusline         Claude Code statusline 集成（stdin JSON）
  agentmeter web                本地仪表盘（默认 http://localhost:8787）
  agentmeter sources            数据源诊断
  agentmeter config init        打印示例配置

通用选项：
  --agent claude,zcode,codex,opencode   只看指定 agent
  --since 2026-09-01 --until 2026-09-08  日期范围
  --last 7                     最近 N 天/月（配合 week/month）
  --json                       机器可读输出
  --cost                       显示成本估算（默认隐藏）
  --markdown                   week 命令输出可分享的 markdown 周报
  --tz Asia/Shanghai           时区覆盖
  --rescan                     忽略缓存全量重扫
  --config <path>              指定配置文件
  --no-color                   关闭颜色
`.trim();

const commands = new Set([
  'today', 'week', 'month', 'projects', 'sessions', 'waste', 'quota',
  'watch', 'statusline', 'web', 'sources', 'config',
]);

export async function main(argv: string[]): Promise<void> {
  const { command, flags } = parseArgs(argv);
  const cmd = command || 'today';

  if (flags['help'] || flags['h'] || cmd === 'help') {
    console.log(HELP);
    return;
  }
  if (cmd === 'config') {
    const { runConfigCommand } = await import('./commands/config.js');
    await runConfigCommand(flags);
    return;
  }
  if (cmd === 'statusline') {
    const { runStatusline } = await import('./commands/statusline.js');
    await runStatusline(flags);
    return;
  }
  if (!commands.has(cmd)) {
    console.error(`未知命令：${cmd}\n`);
    console.log(HELP);
    process.exitCode = 1;
    return;
  }

  const needsTraces = cmd === 'waste' || cmd === 'web' || cmd === 'quota' || flags['markdown'] === true;
  const ctx = await buildContext({ flags, withTraces: needsTraces });

  switch (cmd) {
    case 'today':
    case 'week':
    case 'month':
      await runReportCommand(ctx, cmd, flags);
      break;
    case 'sources':
      runSourcesCommand(ctx);
      break;
    case 'projects': {
      const { runProjectsCommand } = await import('./commands/projects.js');
      await runProjectsCommand(ctx, flags);
      break;
    }
    case 'sessions': {
      const { runSessionsCommand } = await import('./commands/sessions.js');
      await runSessionsCommand(ctx, flags);
      break;
    }
    case 'waste': {
      const { runWasteCommand } = await import('./commands/waste.js');
      await runWasteCommand(ctx, flags);
      break;
    }
    case 'quota': {
      const { runQuotaCommand } = await import('./commands/quota.js');
      await runQuotaCommand(ctx, flags);
      break;
    }
    case 'watch': {
      const { runWatchCommand } = await import('./commands/watch.js');
      await runWatchCommand(ctx, flags);
      break;
    }
    case 'web': {
      const { runWebCommand } = await import('./commands/web.js');
      await runWebCommand(ctx, flags);
      break;
    }
  }
}

main(process.argv.slice(2)).catch((err) => {
  console.error('agentmeter 出错了：', err?.message || err);
  if (process.env.AGENTMETER_DEBUG) console.error(err?.stack);
  process.exitCode = 1;
});
