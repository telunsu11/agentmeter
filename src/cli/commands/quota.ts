import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { CliContext } from '../context.js';
import { QuotaStatus, fmtQuotaReset, quotaStatus as computeQuotaStatus } from '../../core/quota.js';
import { AgentMeterConfig } from '../../core/model.js';
import { loadConfig } from '../../core/config.js';
import { C, fmtNum, fmtTokens, renderTable } from '../format.js';

/** quota：配额窗口使用情况；`quota preset <name>` 一键写入套餐预设。 */

export function quotaStatus(ctx: CliContext, now: Date): QuotaStatus[] {
  return computeQuotaStatus(ctx.events, ctx.config, ctx.tz, now);
}

/* ---------------- 配额预设模板 ----------------
 * 数字为社区估算值（官方未公布精确 token 限额），写入后可自行修改。
 * `agentmeter quota preset list` 查看，`preset <name> --write` 合并写入配置。
 */

interface QuotaPreset {
  name: string;
  desc: string;
  quotas: AgentMeterConfig['quotas'];
}

const PRESETS: QuotaPreset[] = [
  {
    name: 'claude-pro',
    desc: 'Claude Pro（~44M 加权 token / 滚动 5h，社区估算）',
    quotas: { claude: { windows: [{ type: 'rolling', hours: 5, limitTokens: 44_000_000 }] } },
  },
  {
    name: 'claude-max5x',
    desc: 'Claude Max 5×（~154M / 滚动 5h + ~770M / 周，社区估算）',
    quotas: {
      claude: {
        windows: [
          { type: 'rolling', hours: 5, limitTokens: 154_000_000 },
          { type: 'weekly', limitTokens: 770_000_000 },
        ],
      },
    },
  },
];

export async function runQuotaCommand(ctx: CliContext, flags: Record<string, string | boolean>): Promise<void> {
  const sub = process.argv.slice(2).find((a) => !a.startsWith('-') && a !== 'quota');
  if (sub === 'preset') {
    await runQuotaPreset(flags);
    return;
  }

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
    console.log('一键写入套餐预设（社区估算额度）：');
    for (const p of PRESETS) {
      console.log(`  agentmeter quota preset ${C.cyan(p.name)} --write   ${C.dim(p.desc)}`);
    }
    console.log('\n或手动在 agentmeter.json / ~/.config/agentmeter/config.json 配置 quotas，完整示例：agentmeter config init');
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

async function runQuotaPreset(flags: Record<string, string | boolean>): Promise<void> {
  const argv = process.argv.slice(2);
  const name = argv[argv.indexOf('preset') + 1];
  if (!name || name.startsWith('-') || name === 'list') {
    console.log(C.bold('可用配额预设（数字为社区估算，写入后可自行修改）：'));
    console.log();
    for (const p of PRESETS) {
      console.log(`  ${C.cyan(p.name.padEnd(14))} ${p.desc}`);
    }
    console.log();
    console.log(C.dim('用法：agentmeter quota preset <name> [--write]   不带 --write 只打印配置片段'));
    console.log(C.dim('欢迎 PR 补充其他套餐（GLM Coding Plan / Codex Plus / Qwen …）的实际额度。'));
    return;
  }
  const preset = PRESETS.find((p) => p.name === name);
  if (!preset) {
    console.error(C.yellow(`未知预设：${name}（quota preset list 查看可用项）`));
    process.exitCode = 1;
    return;
  }
  const snippet = JSON.stringify({ quotas: preset.quotas }, null, 2);
  if (flags['write'] !== true) {
    console.log(snippet);
    console.log(C.dim('\n加 --write 合并进配置文件。'));
    return;
  }

  // 合并写入：优先 ./agentmeter.json，否则 ~/.config/agentmeter/config.json
  const candidates = [
    path.join(process.cwd(), 'agentmeter.json'),
    path.join(os.homedir(), '.config', 'agentmeter', 'config.json'),
  ];
  const target = fs.existsSync(candidates[0]) ? candidates[0] : candidates[1];
  let config: AgentMeterConfig = {};
  if (fs.existsSync(target)) {
    config = loadConfig(target);
  } else {
    fs.mkdirSync(path.dirname(target), { recursive: true });
  }
  config.quotas = { ...(config.quotas || {}), ...(preset.quotas || {}) };
  fs.writeFileSync(target, JSON.stringify(config, null, 2) + '\n');
  console.log(C.green(`已写入 ${target}`));
  console.log(C.dim(`包含预设：${preset.desc}`));
  console.log('运行 agentmeter quota 查看进度，agentmeter watch 开启预警。');
}
