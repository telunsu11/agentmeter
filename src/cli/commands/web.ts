import { CliContext } from '../context.js';
import { flagNumber } from '../args.js';
import { Scanner } from '../../core/scanner.js';
import { adaptersFor } from '../../adapters/index.js';
import { startWebServer } from '../../web/server.js';
import { C } from '../format.js';

/** web：本地仪表盘（默认 http://127.0.0.1:8787，只绑回环地址） */
export async function runWebCommand(ctx: CliContext, flags: Record<string, string | boolean>): Promise<void> {
  const port = flagNumber(flags, 'port') ?? 8787;
  const server = startWebServer(ctx, port);
  const addr = server.address();
  const url = typeof addr === 'object' && addr ? `http://127.0.0.1:${addr.port}` : `http://127.0.0.1:${port}`;
  console.log(C.bold(C.blue('⚡ agentmeter web')));
  console.log(`  ${url}   ${C.dim('仅本机可访问，Ctrl+C 停止')}`);

  // 页面长开时定时增量刷新底层数据（扫描缓存命中时开销极小）
  const refresh = setInterval(() => {
    const scanner = new Scanner({ adapters: adaptersFor(), config: ctx.config, withTraces: true });
    scanner.scan().then((s) => {
      ctx.events = s.events;
      ctx.traces = s.traces;
    }).catch(() => {});
  }, 30_000);

  const shutdown = () => {
    clearInterval(refresh);
    server.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
