import { AgentId } from '../core/model.js';
import { AgentAdapter } from '../core/scanner.js';
import { claudeAdapter } from './claude.js';
import { zcodeAdapter } from './zcode.js';
import { codexAdapter } from './codex.js';
import { opencodeAdapter } from './opencode.js';

export const ADAPTERS: Record<AgentId, AgentAdapter> = {
  claude: claudeAdapter,
  zcode: zcodeAdapter,
  codex: codexAdapter,
  opencode: opencodeAdapter,
};

export function adaptersFor(ids?: AgentId[]): AgentAdapter[] {
  if (!ids || ids.length === 0) return Object.values(ADAPTERS);
  return ids.map((id) => ADAPTERS[id]).filter(Boolean);
}
