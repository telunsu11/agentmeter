import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { configExample } from '../../core/config.js';
import { C } from '../format.js';

/**
 * config init [--write]：打印（或写入）示例配置。
 * 查找顺序：./agentmeter.json > ~/.config/agentmeter/config.json
 */
export async function runConfigCommand(flags: Record<string, string | boolean>): Promise<void> {
  const sub = process.argv.slice(2).find((a) => !a.startsWith('-') && a !== 'config');
  if (sub !== 'init') {
    console.log(C.dim('用法：agentmeter config init [--write]'));
    return;
  }
  const example = configExample();
  if (flags['write']) {
    const target = fs.existsSync('agentmeter.json')
      ? path.resolve('agentmeter.json')
      : path.join(os.homedir(), '.config', 'agentmeter', 'config.json');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (fs.existsSync(target)) {
      console.error(C.yellow(`已存在 ${target}，不覆盖。`));
      process.exitCode = 1;
      return;
    }
    fs.writeFileSync(target, example + '\n');
    console.log(C.green(`已写入 ${target}`));
  } else {
    console.log(example);
  }
}
