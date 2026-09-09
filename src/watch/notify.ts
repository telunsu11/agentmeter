import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

const execFileP = promisify(execFile);

/**
 * 系统通知与预警状态。
 * 预警去重：每个 (agent, window, threshold) 只在上穿时通知一次，
 * 用量回落（窗口重置）后重新武装。
 */

export type NotifyChannel = 'osascript' | 'notify-send' | 'none';

export function detectChannel(pref?: NotifyChannel): NotifyChannel {
  if (pref && pref !== 'none') return pref;
  if (pref === 'none') return 'none';
  if (process.platform === 'darwin') return 'osascript';
  if (process.platform === 'linux') return 'notify-send';
  return 'none';
}

export async function sendNotification(channel: NotifyChannel, title: string, body: string): Promise<boolean> {
  try {
    if (channel === 'osascript') {
      const text = body.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      await execFileP('osascript', ['-e', `display notification "${text}" with title "${title}" sound name "Glass"`]);
      return true;
    }
    if (channel === 'notify-send') {
      await execFileP('notify-send', [title, body]);
      return true;
    }
  } catch {
    // 通知失败不影响主流程
  }
  return false;
}

export interface AlertState {
  /** key → 上次是否处于超阈值状态（true=已通知待回落） */
  armed: Record<string, boolean>;
}

export function alertStatePath(cacheDir: string): string {
  return path.join(cacheDir, 'alert-state.json');
}

export function loadAlertState(cacheDir: string): AlertState {
  try {
    return JSON.parse(fs.readFileSync(alertStatePath(cacheDir), 'utf8'));
  } catch {
    return { armed: {} };
  }
}

export function saveAlertState(cacheDir: string, state: AlertState): void {
  fs.mkdirSync(cacheDir, { recursive: true });
  const tmp = alertStatePath(cacheDir) + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state));
  fs.renameSync(tmp, alertStatePath(cacheDir));
}

export function defaultCacheDirCompat(): string {
  return process.env.AGENTMETER_CACHE_DIR || path.join(os.homedir(), '.cache', 'agentmeter');
}
