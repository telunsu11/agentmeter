import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { AgentMeterConfig } from './model.js';

/**
 * 配置加载：--config > ./agentmeter.json > ~/.config/agentmeter/config.json
 * 全部可选——没有配置时用内置默认值即可跑。
 */

export function loadConfig(explicitPath?: string): AgentMeterConfig {
  const candidates = explicitPath
    ? [explicitPath]
    : [path.join(process.cwd(), 'agentmeter.json'), path.join(os.homedir(), '.config', 'agentmeter', 'config.json')];
  for (const p of candidates) {
    try {
      const raw = fs.readFileSync(p, 'utf8');
      return validateConfig(JSON.parse(raw), p);
    } catch (err: any) {
      if (err && err.code === 'ENOENT') continue;
      // 配置文件存在但坏了：明确报错，不静默吞掉
      throw new Error(`配置文件解析失败 ${p}: ${err.message}`);
    }
  }
  return {};
}

export function validateConfig(raw: any, p: string): AgentMeterConfig {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error(`配置文件 ${p} 顶层必须是对象`);
  }
  // 宽松校验：只检查会用到的关键字段类型，未知字段透传
  if (raw.quotas && typeof raw.quotas !== 'object') throw new Error('quotas 必须是对象');
  if (raw.alerts) {
    if (raw.alerts.thresholds && !Array.isArray(raw.alerts.thresholds)) throw new Error('alerts.thresholds 必须是数组');
    if (raw.alerts.notify && !['osascript', 'notify-send', 'none'].includes(raw.alerts.notify)) {
      throw new Error('alerts.notify 必须是 osascript | notify-send | none');
    }
  }
  return raw as AgentMeterConfig;
}

export function configExample(): string {
  return JSON.stringify(
    {
      quotas: {
        claude: { windows: [{ type: 'rolling', hours: 5, limitTokens: 44000000 }] },
        zcode: { windows: [{ type: 'monthly', limitTokens: 60000000 }] },
      },
      alerts: { thresholds: [0.8, 0.95], notify: 'osascript' },
      pricing: { 'claude-sonnet-4-5': { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 } },
      paths: {},
      timezone: 'Asia/Shanghai',
      waste: { loopMinRepeats: 3, duplicateReadMin: 4, minTokensToReport: 10000, contextBloatTokens: 150000, contextBloatMinTurns: 3 },
    },
    null,
    2,
  );
}
