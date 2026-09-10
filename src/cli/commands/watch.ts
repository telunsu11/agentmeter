import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';
import { buildContext, CliContext } from '../context.js';
import { flagNumber } from '../args.js';
import { loadConfig } from '../../core/config.js';
import { quotaStatus as computeQuotaStatus, QuotaStatus } from '../../core/quota.js';
import {
  AlertState, NotifyChannel, detectChannel, loadAlertState, saveAlertState, sendNotification, defaultCacheDirCompat,
} from '../../watch/notify.js';
import { C, fmtTokens } from '../format.js';

/**
 * watch：配额监控守护。
 *   agentmeter watch              前台循环（默认 30s 一查）
 *   agentmeter watch --once       单次检查（配合 cron/launchd）
 *   agentmeter watch install      生成 launchd/systemd 自启动配置
 */

export async function runWatchCommand(_ctx: CliContext, flags: Record<string, string | boolean>): Promise<void> {
  const sub = process.argv.slice(2).find((a) => !a.startsWith('-') && a !== 'watch');
  if (sub === 'install') {
    installWatch();
    return;
  }

  const once = flags['once'] === true;
  const quiet = flags['quiet'] === true;
  const interval = Math.max(5, flagNumber(flags, 'interval') ?? 30);

  const check = async (): Promise<void> => {
    const ctx = await buildContext({ flags });
    const now = new Date();
    const statuses = computeQuotaStatus(ctx.events, ctx.config, ctx.tz, now);
    const cacheDir = defaultCacheDirCompat();
    const state = loadAlertState(cacheDir);
    const thresholds = (ctx.config.alerts?.thresholds ?? [0.8, 0.95]).slice().sort((a, b) => a - b);
    const channel: NotifyChannel = detectChannel(ctx.config.alerts?.notify as NotifyChannel | undefined);

    for (const s of statuses) {
      if (!s.limitTokens && !s.limitTurns) continue;
      for (const th of thresholds) {
        const key = `${s.agent}|${s.windowDesc}|${th}`;
        const wasArmed = state.armed[key] === true;
        const over = s.pct >= th;
        if (over && !wasArmed) {
          state.armed[key] = true;
          const msg = `${s.label} 已用 ${fmtTokens(s.used)}（${Math.round(s.pct * 100)}% ≥ 阈值 ${Math.round(th * 100)}%）` +
            (s.resetsAt ? `，重置于 ${s.resetsAt.slice(11, 16)}Z` : '');
          if (!quiet) console.log(C.yellow(`⚠️  ${msg}`));
          if (channel !== 'none') await sendNotification(channel, 'agentmeter 配额预警', msg);
        } else if (!over && wasArmed && s.pct < th - 0.05) {
          // 用量回落（窗口滚动/重置）→ 重新武装
          state.armed[key] = false;
        }
      }
    }
    // 该 compact 了：近 15 分钟活跃的会话，上下文逼近健康线即提醒（事前预防）
    const compactThreshold = ctx.config.waste?.contextBloatTokens ?? 400_000;
    const activeMs = now.getTime() - 15 * 60_000;
    const lastCtx = new Map<string, { agent: string; sessionId: string; projectDir: string; ctxSize: number; ts: string }>();
    for (const e of ctx.events) {
      const t = Date.parse(e.ts);
      if (t < activeMs) continue;
      const key = `${e.agent}:${e.sessionId}`;
      const prev = lastCtx.get(key);
      if (!prev || t >= Date.parse(prev.ts)) {
        lastCtx.set(key, {
          agent: e.agent,
          sessionId: e.sessionId,
          projectDir: e.projectDir,
          ctxSize: e.inputTokens + e.cacheReadTokens + e.cacheWriteTokens,
          ts: e.ts,
        });
      }
    }
    for (const s of lastCtx.values()) {
      const key = `compact|${s.agent}|${s.sessionId}`;
      const wasArmed = state.armed[key] === true;
      if (s.ctxSize >= compactThreshold * 0.9 && !wasArmed) {
        state.armed[key] = true;
        const proj = s.projectDir.split('/').pop() || s.projectDir || '?';
        const msg = `${s.agent} 会话上下文已达 ${fmtTokens(s.ctxSize)}（健康线 ${fmtTokens(compactThreshold)}）· ${proj}，建议 /compact 或开新会话`;
        if (!quiet) console.log(C.yellow(`⚠️  ${msg}`));
        if (channel !== 'none') await sendNotification(channel, 'agentmeter · 该 compact 了', msg);
      } else if (s.ctxSize < compactThreshold * 0.5 && wasArmed) {
        // 已 compact（上下文回落）→ 重新武装
        state.armed[key] = false;
      }
    }

    saveAlertState(cacheDir, state);

    if (!quiet) {
      const line = statuses
        .filter((s) => s.limitTokens || s.limitTurns)
        .map((s) => formatStatus(s))
        .join('  ·  ');
      console.log(`${C.dim(new Date().toLocaleTimeString())}  ${line || C.dim('未配置限额（agentmeter config init）')}`);
    }
  };

  if (once) {
    await check();
    return;
  }

  console.log(C.bold(C.blue(`⚡ agentmeter watch · 每 ${interval}s 检查一次，Ctrl+C 退出`)));
  await check();
  const timer = setInterval(() => {
    check().catch((e) => console.error('watch 检查失败：', e.message));
  }, interval * 1000);
  const shutdown = () => {
    clearInterval(timer);
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

function formatStatus(s: QuotaStatus): string {
  const pct = Math.round(s.pct * 100) + '%';
  const colored = s.pct >= 0.95 ? C.red(pct) : s.pct >= 0.8 ? C.yellow(pct) : C.green(pct);
  return `${s.label} ${colored}`;
}

/* ---------------- launchd / systemd 安装 ---------------- */

function installWatch(): void {
  const nodeBin = process.execPath;
  // dist/cli/commands/watch.js → dist/cli/main.js
  const here = path.dirname(fileURLToPath(import.meta.url));
  const mainJs = fs.existsSync(path.join(here, 'main.js'))
    ? path.join(here, 'main.js')
    : path.resolve(here, '..', '..', 'src', 'cli', 'main.ts'); // dev 场景兜底
  const intervalMin = 5;

  if (process.platform === 'darwin') {
    const plistPath = path.join(os.homedir(), 'Library', 'LaunchAgents', 'com.agentmeter.watch.plist');
    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.agentmeter.watch</string>
  <key>ProgramArguments</key>
  <array>
    <string>${nodeBin}</string>
    <string>${mainJs}</string>
    <string>watch</string>
    <string>--once</string>
    <string>--quiet</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>StartInterval</key><integer>${intervalMin * 60}</integer>
  <key>StandardOutPath</key><string>${path.join(os.homedir(), '.cache', 'agentmeter', 'watch.log')}</string>
  <key>StandardErrorPath</key><string>${path.join(os.homedir(), '.cache', 'agentmeter', 'watch.log')}</string>
</dict>
</plist>
`;
    fs.mkdirSync(path.dirname(plistPath), { recursive: true });
    if (fs.existsSync(plistPath)) {
      console.log(C.yellow(`已存在 ${plistPath}，先卸载：launchctl unload ${plistPath}`));
    }
    fs.writeFileSync(plistPath, plist);
    console.log(C.green(`已生成 ${plistPath}（每 ${intervalMin} 分钟静默检查一次）`));
    console.log(`启用：  launchctl load ${plistPath}`);
    console.log(`停用：  launchctl unload ${plistPath}`);
    console.log(C.dim('提醒：先配置配额限额（agentmeter config init --write 后编辑），否则没有可预警的对象。'));
    return;
  }

  if (process.platform === 'linux') {
    const unitPath = path.join(os.homedir(), '.config', 'systemd', 'user', 'agentmeter-watch.service');
    const unit = `[Unit]
Description=agentmeter quota watch

[Service]
Type=oneshot
ExecStart=${nodeBin} ${mainJs} watch --once --quiet

[Timer]
OnCalendar=*:0/${intervalMin}
Persistent=true

[Install]
WantedBy=timers.target
`;
    fs.mkdirSync(path.dirname(unitPath), { recursive: true });
    fs.writeFileSync(unitPath, unit);
    console.log(C.green(`已生成 ${unitPath}`));
    console.log(`启用：  systemctl --user daemon-reload && systemctl --user enable --now agentmeter-watch.timer`);
    return;
  }

  console.log(C.yellow('当前平台没有自动安装模板；可用 cron 定时执行：'));
  console.log(`  */${intervalMin} * * * * ${nodeBin} ${mainJs} watch --once --quiet`);
}
