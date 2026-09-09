/** 极简参数解析：--flag value / --flag=value / -f value / 位置参数 / 布尔 flag */

export interface ParsedArgs {
  command: string;
  positionals: string[];
  flags: Record<string, string | boolean>;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};
  let command = '';

  let i = 0;
  while (i < argv.length) {
    const a = argv[i];
    if (a.startsWith('--') || (a.startsWith('-') && a.length === 2)) {
      const name = a.startsWith('--') ? a.slice(2) : a.slice(1);
      const eq = name.indexOf('=');
      if (eq >= 0) {
        flags[name.slice(0, eq)] = name.slice(eq + 1);
      } else if (i + 1 < argv.length && !argv[i + 1].startsWith('-') && needsValue(name)) {
        flags[name] = argv[i + 1];
        i++;
      } else {
        flags[name] = true;
      }
    } else {
      if (!command) command = a;
      else positionals.push(a);
    }
    i++;
  }

  return { command, positionals, flags };
}

/** 这些 flag 后面跟值；其余视为布尔 */
const VALUE_FLAGS = new Set([
  'agent', 'since', 'until', 'last', 'top', 'type', 'config', 'tz', 'interval',
  'port', 'min-tokens', 'project', 'json', 'limit',
]);

function needsValue(name: string): boolean {
  return VALUE_FLAGS.has(name);
}

export function flagString(flags: Record<string, string | boolean>, name: string): string | undefined {
  const v = flags[name];
  return typeof v === 'string' ? v : undefined;
}

export function flagNumber(flags: Record<string, string | boolean>, name: string): number | undefined {
  const v = flags[name];
  if (typeof v !== 'string') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

export function flagBool(flags: Record<string, string | boolean>, name: string): boolean {
  return flags[name] === true;
}
