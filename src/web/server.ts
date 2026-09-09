import * as http from 'node:http';
import { CliContext } from '../cli/context.js';
import { filterEvents, groupByDay, groupByModel, groupByProject, rawTotal, totalsOf, weightedTotal } from '../core/aggregate.js';
import { detectWaste, wasteTotals } from '../core/waste/engine.js';
import { quotaStatus } from '../core/quota.js';
import { AgentId, WasteType } from '../core/model.js';

/**
 * 本地仪表盘：只绑 127.0.0.1，单页 + 一个 JSON API，零外部依赖（无 CDN）。
 */

export function startWebServer(ctx: CliContext, port: number): http.Server {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    if (url.pathname === '/api/data.json') {
      handleApi(ctx, req, res, url);
    } else if (url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(PAGE);
    } else {
      res.writeHead(404);
      res.end('not found');
    }
  });
  server.listen(port, '127.0.0.1');
  return server;
}

export function handleApi(ctx: CliContext, req: http.IncomingMessage, res: http.ServerResponse, url: URL): void {
  const days = Math.max(1, Math.min(365, Number(url.searchParams.get('days')) || 30));
  const tz = ctx.tz;
  const since = new Date(Date.now() - days * 86400_000).toISOString().slice(0, 10);
  const events = filterEvents(ctx.events, { since, tz });

  const byDay = groupByDay(events, tz).map((d) => ({
    day: d.key,
    weighted: weightedTotal(d.totals),
    raw: rawTotal(d.totals),
    byAgent: Object.fromEntries(Object.entries(d.byAgent).map(([a, t]) => [a, weightedTotal(t)])),
  }));

  const byModel = groupByModel(events).slice(0, 10).map((m) => ({ model: m.model, weighted: weightedTotal(m.totals), events: m.events }));
  const byProject = groupByProject(events).slice(0, 10).map((p) => ({
    project: p.projectDir, weighted: rawTotal(p.totals), sessions: p.sessions.size, events: p.events, agents: [...p.agents],
  }));

  const findings = detectWaste(ctx.traces, ctx.config, since, undefined, tz);
  const { byType, grand } = wasteTotals(findings);
  const scopeTotal = rawTotal(totalsOf(events));

  const quotas = quotaStatus(ctx.events, ctx.config, tz, new Date());

  const payload = {
    generatedAt: new Date().toISOString(),
    tz,
    days,
    scopeTotal,
    today: byDay[byDay.length - 1]?.weighted ?? 0,
    waste: {
      total: rawTotal(grand),
      ratio: scopeTotal > 0 ? rawTotal(grand) / scopeTotal : 0,
      byType: Object.fromEntries(
        (Object.keys(byType) as WasteType[]).map((t) => [t, rawTotal(byType[t])]),
      ),
      topFindings: findings.slice(0, 12).map((f) => ({
        type: f.type, severity: f.severity, agent: f.agent, project: f.projectDir,
        ts: f.ts, count: f.count, tokens: rawTotal(f.tokensWasted), detail: f.detail,
      })),
    },
    byDay,
    byModel,
    byProject,
    quotas,
  };

  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(payload));
}

const AGENT_COLORS: Record<string, string> = {
  claude: '#d193f5',
  zcode: '#56c8f5',
  codex: '#6fe08f',
  opencode: '#f5cf6d',
};

const PAGE = `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>agentmeter · 本地仪表盘</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: #0c1017; color: #d5dbe6; font: 14px/1.6 ui-monospace, "SF Mono", Menlo, monospace; padding: 28px; }
  h1 { font-size: 18px; color: #7ec8f0; margin-bottom: 4px; }
  .sub { color: #5c6a80; font-size: 12px; margin-bottom: 24px; }
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; margin-bottom: 28px; }
  .card { background: #131a26; border: 1px solid #1f2a3a; border-radius: 10px; padding: 14px 16px; }
  .card .k { color: #5c6a80; font-size: 11px; }
  .card .v { font-size: 22px; color: #e8edf5; margin-top: 2px; }
  .card .v.warn { color: #f08c7e; }
  section { margin-bottom: 28px; }
  h2 { font-size: 13px; color: #8fa2bd; margin-bottom: 10px; border-bottom: 1px solid #1f2a3a; padding-bottom: 6px; }
  table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
  th { text-align: left; color: #5c6a80; font-weight: normal; padding: 4px 8px; border-bottom: 1px solid #1f2a3a; }
  td { padding: 4px 8px; border-bottom: 1px solid #161f2e; }
  td.num { text-align: right; font-variant-numeric: tabular-nums; }
  tr:hover td { background: #131a26; }
  .bar { height: 8px; border-radius: 4px; background: #1f2a3a; overflow: hidden; }
  .bar > div { height: 100%; background: linear-gradient(90deg,#2e9cd6,#56c8f5); }
  .sev-high { color: #f08c7e; } .sev-medium { color: #f5cf6d; } .sev-low { color: #6b7a92; }
  footer { color: #46536a; font-size: 11px; margin-top: 32px; }
</style>
</head>
<body>
<h1>⚡ agentmeter</h1>
<div class="sub">纯本地仪表盘 · 仅供 127.0.0.1 访问 · 数据在页面打开瞬间从本地日志增量解析</div>

<div class="cards" id="cards"></div>

<section>
  <h2>逐日用量（加权 token）</h2>
  <div id="chart"></div>
</section>

<section>
  <h2>项目 Top 10</h2>
  <table id="projects"></table>
</section>

<section>
  <h2>模型 Top 10</h2>
  <table id="models"></table>
</section>

<section>
  <h2>浪费审计</h2>
  <div id="waste"></div>
</section>

<section>
  <h2>配额窗口</h2>
  <table id="quotas"></table>
</section>

<footer>agentmeter · MIT · 零遥测，离开本机没有任何数据外发</footer>

<script>
const fmt = (n) => n >= 1e9 ? (n/1e9).toFixed(2)+'B' : n >= 1e6 ? (n/1e6).toFixed(2)+'M' : n >= 1e3 ? (n/1e3).toFixed(1)+'K' : String(n);
const esc = (s) => String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const TYPE_LABEL = {api_retry:'API 错误/重试', failure_loop:'失败循环', context_restart:'上下文重启', ineffective_cache:'缓存空转', zombie_session:'僵尸会话', duplicate_reads:'重复读取', context_bloat:'长会话税'};

async function load() {
  const r = await fetch('/api/data.json?days=30');
  const d = await r.json();

  document.getElementById('cards').innerHTML = [
    card('今日（加权）', fmt(d.today)),
    card('近 ' + d.days + ' 天（raw）', fmt(d.scopeTotal)),
    card('估算浪费', fmt(d.waste.total), (d.waste.ratio*100).toFixed(1) + '% · ' + d.tz, d.waste.ratio > 0.15),
    card('数据截至', d.generatedAt.slice(11,19) + ' UTC'),
  ].join('');

  // 逐日堆叠柱状图（纯 SVG）
  const max = Math.max(1, ...d.byDay.map(x => x.weighted));
  const W = Math.max(600, d.byDay.length * 26), H = 160;
  const agents = Object.keys(AGENT_COLORS__);
  let bars = '';
  d.byDay.forEach((x, i) => {
    let y = H;
    const bw = 18, gap = 8, bx = i * (bw + gap) + 4;
    let total = 0;
    for (const [a, v] of Object.entries(x.byAgent || {})) {
      const h = Math.round((v / max) * (H - 20));
      if (h > 0) { y -= h; total += v;
        bars += '<rect x="'+bx+'" y="'+y+'" width="'+bw+'" height="'+h+'" fill="'+(AGENT_COLORS__[a]||'#888')+'" rx="2"><title>'+a+' '+fmt(v)+'</title></rect>';
      }
    }
    if (total === 0) bars += '<rect x="'+bx+'" y="'+H-2+'" width="'+bw+'" height="2" fill="#1f2a3a"></rect>';
    bars += '<text x="'+(bx+bw/2)+'" y="'+(H+14)+'" font-size="9" fill="#46536a" text-anchor="middle">'+x.day.slice(5)+'</text>';
  });
  document.getElementById('chart').innerHTML =
    '<svg viewBox="0 0 '+W+' '+(H+20)+'" width="100%" height="180" preserveAspectRatio="xMinYMax meet">'+bars+'</svg>' +
    '<div style="font-size:11px;color:#5c6a80">' + agents.map(a => '<span style="color:'+(AGENT_COLORS__[a]||'#888')+'">■</span> '+a).join(' · ') + '</div>';

  document.getElementById('projects').innerHTML =
    '<tr><th>项目</th><th></th><th class="num" style="text-align:right">加权</th><th class="num" style="text-align:right">会话</th><th class="num" style="text-align:right">请求</th><th>agent</th></tr>' +
    d.byProject.map(p => {
      const w = Math.round(p.weighted / Math.max(1, d.byProject[0].weighted) * 100);
      return '<tr><td style="max-width:340px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">'+esc(p.project)+'</td>' +
        '<td style="width:120px"><div class="bar"><div style="width:'+w+'%"></div></div></td>' +
        '<td class="num">'+fmt(p.weighted)+'</td><td class="num">'+p.sessions+'</td><td class="num">'+p.events+'</td><td>'+p.agents.join(',')+'</td></tr>';
    }).join('');

  document.getElementById('models').innerHTML =
    '<tr><th>model</th><th class="num" style="text-align:right">加权</th><th class="num" style="text-align:right">请求</th></tr>' +
    d.byModel.map(m => '<tr><td>'+esc(m.model)+'</td><td class="num">'+fmt(m.weighted)+'</td><td class="num">'+m.events+'</td></tr>').join('');

  document.getElementById('waste').innerHTML =
    '<table><tr><th>类型</th><th class="num" style="text-align:right">token</th><th class="num" style="text-align:right">信号数</th></tr>' +
    Object.entries(d.waste.byType).filter(([t,v]) => v > 0).map(([t, v]) => {
      const n = d.waste.topFindings.filter(f => f.type === t).length;
      return '<tr><td>'+TYPE_LABEL[t]+'</td><td class="num">'+fmt(v)+'</td><td class="num">'+n+'+</td></tr>';
    }).join('') + '</table>' +
    '<div style="margin-top:10px;font-size:12.5px">' + d.waste.topFindings.slice(0,5).map(f =>
      '<div style="margin-bottom:6px"><span class="sev-'+f.severity+'">●</span> <b>'+TYPE_LABEL[f.type]+'</b> · '+esc(f.agent)+' · '+esc(f.project.split('/').pop()||f.project)+'<br><span style="color:#5c6a80;font-size:11.5px">'+esc(f.detail)+'</span></div>'
    ).join('') + '</div>';

  document.getElementById('quotas').innerHTML = d.quotas.length === 0
    ? '<tr><td style="color:#5c6a80">未配置限额（agentmeter config init）</td></tr>'
    : '<tr><th>窗口</th><th class="num" style="text-align:right">已用</th><th class="num" style="text-align:right">限额</th><th class="num" style="text-align:right">进度</th></tr>' +
      d.quotas.map(q => {
        const pct = q.limitTokens ? Math.round(q.pct*100) : 0;
        const col = q.pct >= 0.95 ? '#f08c7e' : q.pct >= 0.8 ? '#f5cf6d' : '#6fe08f';
        return '<tr><td>'+esc(q.label)+'</td><td class="num">'+fmt(q.used)+'</td><td class="num">'+(q.limitTokens?fmt(q.limitTokens):'—')+'</td><td class="num" style="color:'+col+'">'+pct+'%</td></tr>';
      }).join('');
}
function card(k, v, sub, warn) {
  return '<div class="card"><div class="k">'+k+(sub?' · '+sub:'')+'</div><div class="v'+(warn?' warn':'')+'">'+v+'</div></div>';
}
const AGENT_COLORS__ = {claude:'#d193f5', zcode:'#56c8f5', codex:'#6fe08f', opencode:'#f5cf6d'};
load();
setInterval(load, 30000);
</script>
</body>
</html>`;
