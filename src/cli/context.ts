import { AgentId, AgentMeterConfig, TurnTrace, UsageEvent, ALL_AGENTS } from '../core/model.js';
import { ScanResult, Scanner } from '../core/scanner.js';
import { adaptersFor } from '../adapters/index.js';
import { loadConfig } from '../core/config.js';
import { localTimezone } from '../core/util.js';
import { useColor } from './format.js';

export interface CliContext {
  config: AgentMeterConfig;
  tz: string;
  scan: ScanResult;
  events: UsageEvent[];
  traces: TurnTrace[];
}

export interface CliOptions {
  flags: Record<string, string | boolean>;
  /** 需要轨迹的命令（waste）设 true */
  withTraces?: boolean;
  /** 跳过扫描（如 help/config 命令） */
  noScan?: boolean;
}

export function parseAgentFilter(flags: Record<string, string | boolean>): AgentId[] | undefined {
  const raw = flags['agent'];
  if (typeof raw !== 'string' || !raw) return undefined;
  const parts = raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  const valid = parts.filter((p): p is AgentId => (ALL_AGENTS as string[]).includes(p));
  if (valid.length === 0) return undefined;
  return valid;
}

export async function buildContext(opts: CliOptions): Promise<CliContext> {
  const configPath = typeof opts.flags['config'] === 'string' ? opts.flags['config'] : undefined;
  const config = loadConfig(configPath);
  const tz = (typeof opts.flags['tz'] === 'string' ? opts.flags['tz'] : undefined) || config.timezone || localTimezone();
  useColor(opts.flags['no-color'] !== true && process.stdout.isTTY !== false);

  if (opts.noScan) {
    return { config, tz, scan: { events: [], traces: [], sources: [], parsedFiles: 0, scanMs: 0 }, events: [], traces: [] };
  }

  const agents = parseAgentFilter(opts.flags);
  const scanner = new Scanner({
    adapters: adaptersFor(agents),
    config,
    rescan: opts.flags['rescan'] === true,
    withTraces: opts.withTraces,
  });
  const scan = await scanner.scan();
  const traces = opts.withTraces ? scan.traces : [];
  return { config, tz, scan, events: scan.events, traces };
}
