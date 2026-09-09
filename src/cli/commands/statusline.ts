import { buildContext } from '../context.js';
import { totalsOf, weightedTotal, filterEvents } from '../../core/aggregate.js';
import { dayKey } from '../../core/util.js';
import { C, fmtTokens } from '../format.js';

/**
 * statusline：Claude Code 状态栏集成。
 * settings.json 配置：
 *   "statusLine": { "type": "command", "command": "agentmeter statusline" }
 * Claude 会把会话信息以 JSON 写到 stdin；输出单行用量摘要。
 */

export async function runStatusline(flags: Record<string, string | boolean>): Promise<void> {
  // 读取 stdin（Claude Code 协议），超时或空 stdin 时也能工作
  const stdin = await readStdin(1500).catch(() => '');
  let cwd = '';
  try {
    const info = JSON.parse(stdin || '{}');
    cwd = info?.workspace?.current_dir || info?.cwd || '';
  } catch {}

  const ctx = await buildContext({ flags });
  const tz = ctx.tz;
  const today = dayKey(new Date().toISOString(), tz);
  const todayEvents = filterEvents(ctx.events, { since: today, until: today, tz });
  const t = totalsOf(todayEvents);

  const parts: string[] = [];
  parts.push(`${C.cyan('⚡')}${C.bold(fmtTokens(weightedTotal(t)))}`);
  parts.push(C.dim('today'));

  // 有配额配置时附加最紧的窗口百分比
  const { quotaStatus } = await import('./quota.js');
  const qs = quotaStatus(ctx, new Date());
  const withLimit = qs.filter((s) => s.limitTokens);
  if (withLimit.length > 0) {
    const worst = withLimit.reduce((a, b) => (b.pct > a.pct ? b : a));
    const pctStr = Math.round(worst.pct * 100) + '%';
    const colored = worst.pct >= 0.95 ? C.red(pctStr) : worst.pct >= 0.8 ? C.yellow(pctStr) : C.green(pctStr);
    parts.push(`${worst.label} ${colored}`);
  }

  process.stdout.write(parts.join(' '));
}

function readStdin(timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    if (process.stdin.isTTY) return resolve('');
    let data = '';
    const timer = setTimeout(() => {
      process.stdin.removeAllListeners();
      resolve(data);
    }, timeoutMs);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => (data += chunk));
    process.stdin.on('end', () => {
      clearTimeout(timer);
      resolve(data);
    });
    process.stdin.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}
