/**
 * Standalone read-only page served at `/price-watch/`.
 *
 * This exists so a phone on the same network can open the price history without
 * the DSH Web UI: the Feishu card buttons point here. It is plain HTML + inline
 * CSS/JS (no CDN, no build) and only reads the same JSON API the panel uses.
 */
export function renderPage({ title = '价格监控', origin = '' } = {}) {
  const safeTitle = String(title).replace(/[<>&"]/g, '');
  const safeOrigin = String(origin || '').replace(/[<>&"]/g, '');
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<title>${safeTitle}</title>
<style>
  :root { color-scheme: light dark; --bg:#f6f7f9; --card:#fff; --fg:#1b1f24; --muted:#6b7280; --line:#e5e7eb; --brand:#0e9f6e; --up:#e5484d; --down:#0e9f6e; --track:#eef1f4; }
  @media (prefers-color-scheme: dark) { :root { --bg:#17181a; --card:#202225; --fg:#e8eaed; --muted:#9aa0a6; --line:#2e3134; --track:#2a2d30; } }
  * { box-sizing: border-box; }
  body { margin:0; padding:16px 14px 40px; background:var(--bg); color:var(--fg); font:14px/1.5 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif; }
  h1 { font-size:19px; margin:4px 0 2px; }
  .sub { color:var(--muted); font-size:12px; margin-bottom:14px; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:12px 13px; margin-bottom:10px; }
  .row { display:flex; align-items:baseline; justify-content:space-between; gap:10px; }
  .title { font-weight:600; font-size:14px; }
  .price { font-size:22px; font-weight:700; letter-spacing:-0.02em; }
  .muted { color:var(--muted); font-size:12px; }
  .up { color:var(--up); } .down { color:var(--down); }
  .spark { margin-top:8px; height:34px; width:100%; display:block; }
  .empty { text-align:center; color:var(--muted); padding:40px 0; }
  .chart { width:100%; height:200px; display:block; margin-top:6px; }
  .stat { display:flex; gap:18px; margin-top:8px; }
  .stat div { font-size:12px; color:var(--muted); }
  .stat b { display:block; color:var(--fg); font-size:14px; font-weight:600; }
  .alerts { margin-top:18px; }
  .alert { font-size:12px; color:var(--muted); padding:6px 0; border-top:1px solid var(--line); }
  .alert b { color:var(--fg); font-weight:600; }
  a { color:var(--brand); text-decoration:none; }
</style>
</head>
<body>
<h1>${safeTitle}</h1>
<div class="sub" id="sub">加载中…</div>
<div id="list"></div>
<div class="alerts" id="alerts"></div>
<script>
(function () {
  var BASE = ${JSON.stringify(safeOrigin)} + '/price-watch/api';
  var state = { monitors: [], points: {} };

  function money(n) { return '¥' + Math.round(Number(n) || 0).toLocaleString('zh-CN'); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function ago(iso) {
    if (!iso) return '—';
    var diff = Date.now() - Date.parse(iso);
    if (!isFinite(diff) || diff < 0) return '—';
    var m = Math.floor(diff / 60000);
    if (m < 1) return '刚刚';
    if (m < 60) return m + ' 分钟前';
    var h = Math.floor(m / 60);
    if (h < 24) return h + ' 小时前';
    return Math.floor(h / 24) + ' 天前';
  }
  function spark(points, width, height) {
    var vals = points.map(function (p) { return Number(p[1]); }).filter(function (v) { return isFinite(v) && v > 0; });
    if (vals.length < 2) return '';
    var min = Math.min.apply(null, vals), max = Math.max.apply(null, vals);
    var span = max - min || 1;
    var step = width / (vals.length - 1);
    var d = vals.map(function (v, i) { return (i ? 'L' : 'M') + (i * step).toFixed(1) + ' ' + (height - ((v - min) / span) * (height - 4) - 2).toFixed(1); }).join(' ');
    var color = vals[vals.length - 1] <= vals[0] ? 'var(--down)' : 'var(--up)';
    return '<svg class="spark" viewBox="0 0 ' + width + ' ' + height + '" preserveAspectRatio="none"><path d="' + d + '" fill="none" stroke="' + color + '" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"/></svg>';
  }
  function chart(points) {
    var vals = points.filter(function (p) { return Number(p[1]) > 0; }).map(function (p) { return { at: p[0], v: Number(p[1]) }; });
    if (vals.length < 2) return '<div class="muted">数据点还不够，稍后再看。</div>';
    var W = 340, H = 150, pad = 6;
    var min = Math.min.apply(null, vals.map(function (p) { return p.v; }));
    var max = Math.max.apply(null, vals.map(function (p) { return p.v; }));
    var span = max - min || 1;
    var step = (W - pad * 2) / (vals.length - 1);
    var path = vals.map(function (p, i) {
      var x = pad + i * step, y = H - pad - ((p.v - min) / span) * (H - pad * 2);
      return (i ? 'L' : 'M') + x.toFixed(1) + ' ' + y.toFixed(1);
    }).join(' ');
    return '<svg class="chart" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none"><path d="' + path + '" fill="none" stroke="var(--brand)" stroke-width="2" stroke-linejoin="round"/></svg>' +
      '<div class="stat"><div>最低<b>' + money(min) + '</b></div><div>最高<b>' + money(max) + '</b></div><div>最新<b>' + money(vals[vals.length - 1].v) + '</b></div></div>';
  }

  function renderList() {
    var el = document.getElementById('list');
    if (!state.monitors.length) {
      el.innerHTML = '<div class="empty">还没有监控任务<br/><span class="muted">在 DSH 面板里新建一个</span></div>';
      return;
    }
    el.innerHTML = state.monitors.map(function (m) {
      var latest = m.latest, pts = m.points || [];
      var prev = pts.length > 1 ? Number(pts[pts.length - 2][1]) : null;
      var delta = latest && isFinite(prev) && prev > 0 ? ((latest.total - prev) / prev) * 100 : null;
      var cls = delta == null ? '' : delta > 0 ? 'up' : 'down';
      var deltaText = delta == null ? '' : (delta > 0 ? '↑' : '↓') + Math.abs(delta).toFixed(1) + '%';
      return '<div class="card">' +
        '<div class="row"><span class="title">' + esc(m.title) + '</span>' +
        '<span><span class="price">' + (latest ? money(latest.total) : '—') + '</span> <span class="' + cls + '">' + deltaText + '</span></span></div>' +
        '<div class="row"><span class="muted">' + esc(dateLabel(m)) + '</span><span class="muted">' + ago(latest && latest.at) + '</span></div>' +
        spark(pts, 300, 34) +
        chart(pts) +
        '</div>';
    }).join('');
  }
  function dateLabel(m) {
    var p = m.params || {};
    return p.trip === 'round' ? (p.departDate + ' → ' + p.returnDate) : p.departDate;
  }

  function load() {
    fetch(BASE + '/monitors', { credentials: 'same-origin' })
      .then(function (r) { return r.json(); })
      .then(function (json) {
        state.monitors = (json && json.data && json.data.monitors) || [];
        document.getElementById('sub').textContent = '共 ' + state.monitors.length + ' 个监控 · 更新于 ' + new Date().toLocaleTimeString('zh-CN');
        renderList();
      })
      .catch(function () { document.getElementById('sub').textContent = '读取失败，请确认 DSH 正在运行'; });

    fetch(BASE + '/alerts?limit=8', { credentials: 'same-origin' })
      .then(function (r) { return r.json(); })
      .then(function (json) {
        var items = (json && json.data && json.data.alerts) || [];
        if (!items.length) return;
        document.getElementById('alerts').innerHTML = '<div class="muted" style="margin-bottom:6px">最近提醒</div>' + items.map(function (a) {
          return '<div class="alert"><b>' + esc(a.monitorTitle || '') + '</b>　' + esc(a.rule) + '　' + money(a.total) + '　' + esc(String(a.firedAt || '').slice(5, 16).replace('T', ' ')) + '</div>';
        }).join('');
      })
      .catch(function () {});
  }
  load();
  setInterval(load, 60000);
})();
</script>
</body>
</html>`;
}
