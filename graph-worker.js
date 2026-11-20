/* 道路データの取得・作成と経路計算を、画面を止めずに裏で行う Worker */
importScripts('db.js', 'graph-core.js');

var G = null;      // 読み込んだグラフ
var GC = self.GraphCore;
var SERVERS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter'
];
var KEEP_TAGS = ['highway', 'oneway', 'name', 'ref', 'junction', 'maxspeed', 'service'];

function reply(id, ok, result) { self.postMessage({ id: id, ok: ok, result: result }); }
function progress(id, p) { self.postMessage({ id: id, progress: p }); }

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

async function fetchChunk(q, id, label) {
  var lastErr;
  for (var attempt = 0; attempt < SERVERS.length * 2; attempt++) {
    var url = SERVERS[attempt % SERVERS.length];
    try {
      var ctl = new AbortController();
      var timer = setTimeout(function () { ctl.abort(); }, 300000);
      var res = await fetch(url, { method: 'POST', body: 'data=' + encodeURIComponent(q),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, signal: ctl.signal });
      clearTimeout(timer);
      if (!res.ok) throw new Error('サーバー応答 ' + res.status);
      var json = await res.json();
      if (json.remark && /runtime error|timed out/i.test(json.remark)) throw new Error(json.remark);
      return json.elements || [];
    } catch (e) {
      lastErr = e;
      progress(id, { stage: 'roads', msg: label + '：再試行中（' + (e.message || e) + '）' });
      await sleep(5000 + attempt * 5000);
    }
  }
  throw lastErr;
}

async function build(id, bbox) {
  var chunks = GC.splitBbox(bbox, bbox.rows || 3, bbox.cols || 3);
  var ways = new Map();
  for (var i = 0; i < chunks.length; i++) {
    var c = chunks[i];
    var label = '道路データ ' + (i + 1) + '/' + chunks.length;
    progress(id, { stage: 'roads', done: i, total: chunks.length, msg: label + ' を取得中…' });
    var els = await fetchChunk(GC.overpassQuery(c.s, c.w, c.n, c.e), id, label);
    for (var k = 0; k < els.length; k++) {
      var e = els[k];
      if (e.type !== 'way' || ways.has(e.id) || !e.geometry) continue;
      var t = {};
      KEEP_TAGS.forEach(function (key) { if (e.tags && e.tags[key] !== undefined) t[key] = e.tags[key]; });
      ways.set(e.id, { id: e.id, nodes: e.nodes, geometry: e.geometry, tags: t });
    }
    els = null;
    if (i < chunks.length - 1) await sleep(1500); // サーバーへの配慮
  }
  progress(id, { stage: 'build', done: chunks.length, total: chunks.length, msg: '道路のつながりを計算中…' });
  var g = GC.buildGraph(Array.from(ways.values()));
  ways = null;
  var store = { meta: { version: 1, bbox: bbox, created: Date.now(), nNodes: g.nNodes, nSeg: g.nSeg }, names: g.names };
  GC.GRAPH_KEYS.forEach(function (k) { store[k] = g[k]; });
  progress(id, { stage: 'save', msg: '端末に保存中…' });
  await DB.put('kv', 'graph', store);
  G = GC.prepare(g);
  return store.meta;
}

async function load() {
  if (G) return G.meta;
  var st = await DB.get('kv', 'graph');
  if (!st) return null;
  var g = { nNodes: st.meta.nNodes, nSeg: st.meta.nSeg, names: st.names, meta: st.meta };
  GC.GRAPH_KEYS.forEach(function (k) { g[k] = st[k]; });
  G = GC.prepare(g);
  return st.meta;
}

function snapAll(points, maxM) {
  return points.map(function (p) { return p ? GC.snap(G, p.lat, p.lng, maxM || 2000) : null; });
}

/* 出発地 + 地点 → 最適な順番
 * opts: {start:{lat,lng}, stops:[{lat,lng,priority,rank}], end:'open'|'return'} */
function optimize(id, opts) {
  var pts = [opts.start].concat(opts.stops);
  var snaps = snapAll(pts);
  var n = pts.length;
  var M = GC.matrix(G, snaps, function (d, t) { if (d % 5 === 0 || d === t) progress(id, { stage: 'matrix', done: d, total: t, msg: '所要時間を計算中… ' + d + '/' + t }); });
  progress(id, { stage: 'tsp', msg: '回る順番を考えています…' });
  var endIdx = opts.end === 'return' ? 0 : -1;
  var budget = Math.min(6000, 1500 + n * 40);
  var order = GC.solveGrouped(M, n, 0, opts.stops.map(function (s) { return { rank: s.rank == null ? -1 : s.rank, priority: !!s.priority }; }), endIdx, budget);
  // 区間ごとの時間
  var legs = [], prev = 0, total = 0;
  order.forEach(function (k) { var s = M[prev * n + k]; legs.push(s); total += s; prev = k; });
  if (endIdx === 0) total += M[prev * n + 0];
  var unreachable = [];
  for (i = 1; i < n; i++) if (!snaps[i]) unreachable.push(i - 1);
  return { order: order.map(function (k) { return k - 1; }), legSec: legs, totalSec: total,
    unreachable: unreachable, snapDist: snaps.map(function (s) { return s ? Math.round(s.dist) : null; }) };
}

function route(from, to) {
  var s = GC.snap(G, from.lat, from.lng, 3000), t = GC.snap(G, to.lat, to.lng, 3000);
  if (!s || !t) return null;
  var r = GC.route(G, s, t);
  if (!r) return null;
  r.startSnap = { lat: s.lat, lng: s.lng, dist: s.dist };
  r.endSnap = { lat: t.lat, lng: t.lng, dist: t.dist };
  return r;
}

self.onmessage = async function (ev) {
  var m = ev.data, id = m.id;
  try {
    if (m.type === 'build') reply(id, true, await build(id, m.bbox));
    else if (m.type === 'load') reply(id, true, await load());
    else if (m.type === 'unload') { G = null; reply(id, true, null); }
    else if (!G) reply(id, false, 'nograph');
    else if (m.type === 'optimize') reply(id, true, optimize(id, m.opts));
    else if (m.type === 'route') reply(id, true, route(m.from, m.to));
    else if (m.type === 'snap') reply(id, true, GC.snap(G, m.lat, m.lng, m.maxM || 3000));
    else reply(id, false, 'unknown');
  } catch (e) {
    reply(id, false, (e && e.message) || String(e));
  }
};
