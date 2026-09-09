import { CliContext } from '../context.js';
import { C, fmtNum } from '../format.js';

/** 数据源诊断：各 agent 是否检测到、文件数、事件数、缓存命中情况 */
export function runSourcesCommand(ctx: CliContext): void {
  console.log(C.bold(C.blue('⚡ agentmeter · 数据源')));
  console.log();
  if (ctx.scan.sources.length === 0) {
    console.log(C.yellow('未检测到任何数据源。'));
  }
  for (const s of ctx.scan.sources) {
    const status = s.files === 0 ? C.yellow('无数据') : s.cached ? C.green('缓存命中') : C.green('已解析');
    console.log(
      `  ${C.bold(s.agent.padEnd(9))} ${status.padEnd(12)} ${C.dim(`文件 ${fmtNum(s.files)}  事件 ${fmtNum(s.events)}`)}`,
    );
    console.log(C.dim(`           ${s.dir}`));
  }
  console.log();
  console.log(C.dim(`扫描耗时 ${ctx.scan.scanMs}ms，本次实际解析 ${ctx.scan.parsedFiles} 个文件（0 = 全部命中增量缓存）`));
}
