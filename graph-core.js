/* 道路グラフの作成・地点の吸着・経路探索・巡回順の最適化
 * ブラウザの Worker（importScripts）と Node（require）の両方で動く */
(function (root) {
  'use strict';

  // ---- 道路の種類ごとの想定速度（km/h）----
  var SPEED = {
    motorway: 80, trunk: 60, primary: 50, secondary: 45, tertiary: 40,
    motorway_link: 45, trunk_link: 40, primary_link: 35, secondary_link: 35, tertiary_link: 30,
    unclassified: 30, residential: 25, living_street: 15, service: 15, track: 8, road: 20
  };
  var CLASS_ID = {};
  Object.keys(SPEED).forEach(function (k, i) { CLASS_ID[k] = i; });
  var CLASS_NAME = Object.keys(SPEED);
  var HIGHWAY_RE = '^(' + CLASS_NAME.join('|') + ')$';

  var R = 6371008.8;
  function rad(d) { return d * Math.PI / 180; }
  function hav(lat1, lng1, lat2, lng2) {
    var dLat = rad(lat2 - lat1), dLng = rad(lng2 - lng1);
    var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
  }
  function bearing(lat1, lng1, lat2, lng2) {
    var y = Math.sin(rad(lng2 - lng1)) * Math.cos(rad(lat2));
    var x = Math.cos(rad(lat1)) * Math.sin(rad(lat2)) -
      Math.sin(rad(lat1)) * Math.cos(rad(lat2)) * Math.cos(rad(lng2 - lng1));
    return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
  }

  function overpassQuery(s, w, n, e) {
    return '[out:json][timeout:240];way["highway"~"' + HIGHWAY_RE + '"]' +
      '["access"!~"^(no|private)$"]["motor_vehicle"!~"^(no|private)$"]["area"!="yes"]' +
      '(' + s + ',' + w + ',' + n + ',' + e + ');out body geom qt;';
  }

  // 範囲を縦横に分割（Overpass の負担を減らすため）
  function splitBbox(b, rows, cols) {
    var out = [];
    var dLat = (b.n - b.s) / rows, dLng = (b.e - b.w) / cols;
    for (var r = 0; r < rows; r++) for (var c = 0; c < cols; c++) {
      out.push({ s: +(b.s + r * dLat).toFixed(5), n: +(b.s + (r + 1) * dLat).toFixed(5),
        w: +(b.w + c * dLng).toFixed(5), e: +(b.w + (c + 1) * dLng).toFixed(5) });
    }
    return out;
  }

  function onewayOf(tags, hw) {
    var o = tags.oneway;
    if (o === 'yes' || o === '1' || o === 'true') return 1;
    if (o === '-1' || o === 'reverse') return 2;
    if (o === 'no') return 3;
    if (tags.junction === 'roundabout' || tags.junction === 'circular') return 1;
    if (hw === 'motorway') return 1;
    return 3; // 3 = 両方向
  }

  /* ways: [{id, nodes:[...], geometry:[{lat,lon}], tags}] → グラフ（型付き配列の集まり） */
  function buildGraph(ways) {
    var useCount = new Map();
    var i, j, w;
    for (i = 0; i < ways.length; i++) {
      w = ways[i];
      for (j = 0; j < w.nodes.length; j++) {
        var id = w.nodes[j];
        var add = (j === 0 || j === w.nodes.length - 1) ? 2 : 1;
        useCount.set(id, (useCount.get(id) || 0) + add);
      }
    }
    var nodeIndex = new Map();
    var nLat = [], nLng = [];
    function nodeIdx(id, lat, lng) {
      var k = nodeIndex.get(id);
      if (k === undefined) { k = nLat.length; nodeIndex.set(id, k); nLat.push(Math.round(lat * 1e6)); nLng.push(Math.round(lng * 1e6)); }
      return k;
    }
    var names = [], nameIdx = new Map();
    function nameOf(tags) {
      var s = tags.name || tags.ref || '';
      if (tags.ref && tags.name && /^\d+$/.test(tags.ref) && /^(trunk|primary)/.test(tags.highway)) s = tags.name;
      if (!s) return -1;
      var k = nameIdx.get(s);
      if (k === undefined) { k = names.length; names.push(s); nameIdx.set(s, k); }
      return k;
    }
    var segA = [], segB = [], segLen = [], segCost = [], segDir = [], segName = [], segClass = [], segGeoStart = [], segGeoLen = [];
    var geo = [];
    for (i = 0; i < ways.length; i++) {
      w = ways[i];
      var tags = w.tags || {};
      var hw = tags.highway;
      if (SPEED[hw] === undefined || !w.geometry || w.geometry.length !== w.nodes.length) continue;
      var speed = SPEED[hw];
      var ms = parseFloat(tags.maxspeed);
      if (ms > 0 && ms < speed) speed = Math.max(ms, 10);
      if (hw === 'service' && (tags.service === 'parking_aisle' || tags.service === 'drive-through')) speed = 8;
      var mps = speed / 3.6;
      var dir = onewayOf(tags, hw);
      var nm = nameOf(tags);
      var cls = CLASS_ID[hw];
      var startK = 0;
      var geoStart = geo.length / 2;
      var len = 0;
      geo.push(Math.round(w.geometry[0].lat * 1e6), Math.round(w.geometry[0].lon * 1e6));
      for (j = 1; j < w.nodes.length; j++) {
        var g0 = w.geometry[j - 1], g1 = w.geometry[j];
        len += hav(g0.lat, g0.lon, g1.lat, g1.lon);
        geo.push(Math.round(g1.lat * 1e6), Math.round(g1.lon * 1e6));
        var isJ = j === w.nodes.length - 1 || useCount.get(w.nodes[j]) >= 2;
        if (isJ) {
          var a = nodeIdx(w.nodes[startK], w.geometry[startK].lat, w.geometry[startK].lon);
          var b = nodeIdx(w.nodes[j], g1.lat, g1.lon);
          var gl = geo.length / 2 - geoStart;
          if (a !== b || len > 1) {
            segA.push(a); segB.push(b); segLen.push(Math.max(len, 0.5));
            segCost.push(Math.max(len, 0.5) / mps); segDir.push(dir); segName.push(nm); segClass.push(cls);
            segGeoStart.push(geoStart); segGeoLen.push(gl);
          }
          // 次の区間はこの点から始まる（座標を共有）
          startK = j; len = 0;
          geoStart = geo.length / 2 - 1;
        }
      }
    }
    var nNodes = nLat.length, nSeg = segA.length;
    // 連結成分（無向）で最大のものを求める
    var adjU = buildCSR(nNodes, nSeg, segA, segB, null, true);
    var comp = new Int32Array(nNodes).fill(-1);
    var compSize = [], stack = new Int32Array(nNodes), c = 0;
    for (i = 0; i < nNodes; i++) {
      if (comp[i] !== -1) continue;
      var sp = 0, size = 0; stack[sp++] = i; comp[i] = c;
      while (sp) {
        var u = stack[--sp]; size++;
        for (var e = adjU.start[u]; e < adjU.start[u + 1]; e++) {
          var s = adjU.seg[e]; var v = segA[s] === u ? segB[s] : segA[s];
          if (comp[v] === -1) { comp[v] = c; stack[sp++] = v; }
        }
      }
      compSize.push(size); c++;
    }
    var main = 0;
    for (i = 1; i < compSize.length; i++) if (compSize[i] > compSize[main]) main = i;
    var segMain = new Uint8Array(nSeg);
    for (i = 0; i < nSeg; i++) segMain[i] = comp[segA[i]] === main ? 1 : 0;
    var nodeDeg = new Uint8Array(nNodes);
    for (i = 0; i < nNodes; i++) nodeDeg[i] = Math.min(255, adjU.start[i + 1] - adjU.start[i]);

    var g = {
      version: 1,
      nNodes: nNodes, nSeg: nSeg,
      nodeLat: Int32Array.from(nLat), nodeLng: Int32Array.from(nLng), nodeDeg: nodeDeg,
      segA: Int32Array.from(segA), segB: Int32Array.from(segB),
      segLen: Float32Array.from(segLen), segCost: Float32Array.from(segCost),
      segDir: Uint8Array.from(segDir), segName: Int32Array.from(segName), segClass: Uint8Array.from(segClass),
      segGeoStart: Int32Array.from(segGeoStart), segGeoLen: Int32Array.from(segGeoLen),
      segMain: segMain,
      geo: Int32Array.from(geo),
      names: names
    };
    return g;
  }

  // 有向/無向の隣接リスト（CSR）
  function buildCSR(nNodes, nSeg, segA, segB, segDir, undirected) {
    var cnt = new Int32Array(nNodes + 1), s;
    for (s = 0; s < nSeg; s++) {
      if (undirected || (segDir[s] & 1)) cnt[segA[s] + 1]++;
      if (undirected || (segDir[s] & 2)) cnt[segB[s] + 1]++;
    }
    for (var i = 0; i < nNodes; i++) cnt[i + 1] += cnt[i];
    var total = cnt[nNodes];
    var seg = new Int32Array(total), rev = new Uint8Array(total), pos = cnt.slice(0, nNodes);
    for (s = 0; s < nSeg; s++) {
      if (undirected || (segDir[s] & 1)) { seg[pos[segA[s]]] = s; rev[pos[segA[s]]++] = 0; }
      if (undirected || (segDir[s] & 2)) { seg[pos[segB[s]]] = s; rev[pos[segB[s]]++] = 1; }
    }
    return { start: cnt, seg: seg, rev: rev };
  }

  /* ---------- 経路探索用の準備（読み込み時） ---------- */
  var CELL = 0.002;
  function prepare(g) {
    g.adj = buildCSR(g.nNodes, g.nSeg, g.segA, g.segB, g.segDir, false);
    // 地点吸着用の格子索引
    g.grid = new Map();
    for (var s = 0; s < g.nSeg; s++) {
      if (!g.segMain[s]) continue;
      var st2 = g.segGeoStart[s], n2 = g.segGeoLen[s];
      var seen = new Set();
      for (var k2 = 0; k2 < n2 - 1; k2++) {
        var a = (st2 + k2) * 2, b = a + 2;
        var la1 = g.geo[a] / 1e6, ln1 = g.geo[a + 1] / 1e6, la2 = g.geo[b] / 1e6, ln2 = g.geo[b + 1] / 1e6;
        var r0 = Math.floor(Math.min(la1, la2) / CELL), r1 = Math.floor(Math.max(la1, la2) / CELL);
        var c0 = Math.floor(Math.min(ln1, ln2) / CELL), c1 = Math.floor(Math.max(ln1, ln2) / CELL);
        for (var r = r0; r <= r1; r++) for (var c = c0; c <= c1; c++) {
          var key = r * 1000000 + c;
          if (seen.has(key)) continue; seen.add(key);
          var arr = g.grid.get(key);
          if (!arr) { arr = []; g.grid.set(key, arr); }
          arr.push(s);
        }
      }
    }
    var n = g.nNodes;
    g.dist = new Float64Array(n);
    g.stamp = new Int32Array(n);
    g.done = new Int32Array(n);
    g.prevSeg = new Int32Array(n);
    g.prevRev = new Uint8Array(n);
    g.run = 0;
    g.heap = new Heap(1024);
    return g;
  }
  // 区間内累積距離：区間ごとの配列を遅延生成
  function segCum(g, s) {
    if (!g._cum) g._cum = new Map();
    var c = g._cum.get(s);
    if (c) return c;
    var st = g.segGeoStart[s], n = g.segGeoLen[s];
    c = new Float64Array(n);
    for (var k = 1; k < n; k++) {
      var p = (st + k - 1) * 2, q = (st + k) * 2;
      c[k] = c[k - 1] + hav(g.geo[p] / 1e6, g.geo[p + 1] / 1e6, g.geo[q] / 1e6, g.geo[q + 1] / 1e6);
    }
    // 実長と整合させる
    var scale = c[n - 1] > 0 ? g.segLen[s] / c[n - 1] : 1;
    if (Math.abs(scale - 1) > 1e-3) for (k = 1; k < n; k++) c[k] *= scale;
    if (g._cum.size > 20000) g._cum.clear();
    g._cum.set(s, c);
    return c;
  }

  /* 地点を一番近い道路に吸着 */
  function snap(g, lat, lng, maxM) {
    maxM = maxM || 3000;
    var r0 = Math.floor(lat / CELL), c0 = Math.floor(lng / CELL);
    var best = null;
    var cosLat = Math.cos(rad(lat));
    var mPerDegLat = 111320, mPerDegLng = 111320 * cosLat;
    var maxRing = Math.ceil(maxM / (CELL * mPerDegLng)) + 1;
    var checked = new Set();
    for (var ring = 0; ring <= maxRing; ring++) {
      for (var r = r0 - ring; r <= r0 + ring; r++) for (var c = c0 - ring; c <= c0 + ring; c++) {
        if (Math.abs(r - r0) !== ring && Math.abs(c - c0) !== ring) continue;
        var arr = g.grid.get(r * 1000000 + c);
        if (!arr) continue;
        for (var t = 0; t < arr.length; t++) {
          var s = arr[t];
          if (checked.has(s)) continue; checked.add(s);
          var st = g.segGeoStart[s], n = g.segGeoLen[s];
          var cum = null;
          for (var k = 0; k < n - 1; k++) {
            var a = (st + k) * 2, b = a + 2;
            var ax = (g.geo[a + 1] / 1e6 - lng) * mPerDegLng, ay = (g.geo[a] / 1e6 - lat) * mPerDegLat;
            var bx = (g.geo[b + 1] / 1e6 - lng) * mPerDegLng, by = (g.geo[b] / 1e6 - lat) * mPerDegLat;
            var dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
            var u = L2 > 0 ? -(ax * dx + ay * dy) / L2 : 0;
            if (u < 0) u = 0; else if (u > 1) u = 1;
            var px = ax + u * dx, py = ay + u * dy;
            var d = Math.sqrt(px * px + py * py);
            if (!best || d < best.dist) {
              if (!cum) cum = segCum(g, s);
              var off = cum[k] + u * (cum[k + 1] - cum[k]);
              best = { seg: s, off: off, dist: d, lat: lat + py / mPerDegLat, lng: lng + px / mPerDegLng };
            }
          }
        }
      }
      // 見つかった最短距離がこのリングで保証される半径より小さければ終了
      if (best && best.dist < ring * CELL * Math.min(mPerDegLat, mPerDegLng)) break;
    }
    if (best && best.dist > maxM) return null;
    return best;
  }

  /* ---------- 二分ヒープ ---------- */
  function Heap(cap) { this.k = new Float64Array(cap); this.v = new Int32Array(cap); this.n = 0; }
  Heap.prototype.clear = function () { this.n = 0; };
  Heap.prototype.push = function (key, val) {
    if (this.n === this.k.length) {
      var nk = new Float64Array(this.n * 2), nv = new Int32Array(this.n * 2);
      nk.set(this.k); nv.set(this.v); this.k = nk; this.v = nv;
    }
    var i = this.n++, k = this.k, v = this.v;
    while (i > 0) {
      var p = (i - 1) >> 1;
      if (k[p] <= key) break;
      k[i] = k[p]; v[i] = v[p]; i = p;
    }
    k[i] = key; v[i] = val;
  };
  Heap.prototype.pop = function () { // 最小値の val を返す。topKey に key
    var k = this.k, v = this.v;
    var rv = v[0]; this.topKey = k[0];
    var n = --this.n;
    if (n > 0) {
      var key = k[n], val = v[n], i = 0;
      while (true) {
        var l = 2 * i + 1;
        if (l >= n) break;
        var r = l + 1, m = (r < n && k[r] < k[l]) ? r : l;
        if (k[m] >= key) break;
        k[i] = k[m]; v[i] = v[m]; i = m;
      }
      k[i] = key; v[i] = val;
    }
    return rv;
  };

  /* ---------- ダイクストラ ----------
   * src: snap 結果, targets: snap 結果の配列
   * 戻り値: 各 target への所要秒（到達不可は Infinity） */
  function cpm(g, s) { return g.segCost[s] / g.segLen[s]; }

  function dijkstra(g, src, targets, keepPrev) {
    var run = ++g.run;
    var dist = g.dist, stamp = g.stamp, done = g.done, adj = g.adj, heap = g.heap;
    heap.clear();
    function relax(node, d, ps, pr) {
      if (stamp[node] !== run || d < dist[node]) {
        stamp[node] = run; dist[node] = d;
        if (keepPrev) { g.prevSeg[node] = ps; g.prevRev[node] = pr; }
        heap.push(d, node);
      }
    }
    var s = src.seg, c = cpm(g, s);
    if (g.segDir[s] & 1) relax(g.segB[s], (g.segLen[s] - src.off) * c, -2 - s, 0);
    if (g.segDir[s] & 2) relax(g.segA[s], src.off * c, -2 - s, 1);
    // 必要な端点
    var need = new Map();
    var result = new Float64Array(targets.length).fill(Infinity);
    targets.forEach(function (t, i) {
      if (!t) return;
      if (t.seg === s) {
        var cc = cpm(g, s);
        if (t.off >= src.off && (g.segDir[s] & 1)) result[i] = Math.min(result[i], (t.off - src.off) * cc);
        if (t.off <= src.off && (g.segDir[s] & 2)) result[i] = Math.min(result[i], (src.off - t.off) * cc);
      }
      if (g.segDir[t.seg] & 1) need.set(g.segA[t.seg], true);
      if (g.segDir[t.seg] & 2) need.set(g.segB[t.seg], true);
    });
    var remaining = need.size;
    var bestTarget = Infinity;
    while (heap.n > 0 && remaining > 0) {
      var u = heap.pop(), du = heap.topKey;
      if (done[u] === run || du > dist[u]) continue;
      done[u] = run;
      if (need.has(u)) remaining--;
      for (var e = adj.start[u]; e < adj.start[u + 1]; e++) {
        var sg = adj.seg[e], rv = adj.rev[e];
        var v = rv ? g.segA[sg] : g.segB[sg];
        if (done[v] === run) continue;
        relax(v, du + g.segCost[sg] + turnPenalty(g, sg), sg, rv);
      }
    }
    targets.forEach(function (t, i) {
      if (!t) return;
      var cc = cpm(g, t.seg), a = g.segA[t.seg], b = g.segB[t.seg];
      if ((g.segDir[t.seg] & 1) && done[a] === run) result[i] = Math.min(result[i], dist[a] + t.off * cc);
      if ((g.segDir[t.seg] & 2) && done[b] === run) result[i] = Math.min(result[i], dist[b] + (g.segLen[t.seg] - t.off) * cc);
    });
    return result;
  }
  function turnPenalty(g, s) { return g.segClass[s] >= CLASS_ID.service ? 3 : 0; }

  /* 区間の座標（方向つき、部分切り出し） */
  function segPart(g, s, fromOff, toOff) {
    var cum = segCum(g, s), st = g.segGeoStart[s], n = g.segGeoLen[s];
    function pt(off) {
      var k = 0;
      while (k < n - 2 && cum[k + 1] < off) k++;
      var span = cum[k + 1] - cum[k], u = span > 0 ? (off - cum[k]) / span : 0;
      u = Math.max(0, Math.min(1, u));
      var a = (st + k) * 2, b = a + 2;
      return [(g.geo[a] + u * (g.geo[b] - g.geo[a])) / 1e6, (g.geo[a + 1] + u * (g.geo[b + 1] - g.geo[a + 1])) / 1e6];
    }
    var out = [pt(fromOff)];
    var k;
    if (fromOff <= toOff) {
      for (k = 0; k < n; k++) if (cum[k] > fromOff && cum[k] < toOff) out.push([g.geo[(st + k) * 2] / 1e6, g.geo[(st + k) * 2 + 1] / 1e6]);
    } else {
      for (k = n - 1; k >= 0; k--) if (cum[k] < fromOff && cum[k] > toOff) out.push([g.geo[(st + k) * 2] / 1e6, g.geo[(st + k) * 2 + 1] / 1e6]);
    }
    out.push(pt(toOff));
    return out;
  }

  /* 2点間の経路（座標列と案内） */
  function route(g, src, dst) {
    if (!src || !dst) return null;
    var res = dijkstra(g, src, [dst], true);
    var total = res[0];
    if (!isFinite(total)) return null;
    var run = g.run, t = dst, cc = cpm(g, t.seg), a = g.segA[t.seg], b = g.segB[t.seg];
    var pieces = []; // {seg, from, to}
    var viaNode = -1, best = Infinity;
    // 同じ区間で直接
    if (t.seg === src.seg) {
      if (t.off >= src.off && (g.segDir[t.seg] & 1)) { best = (t.off - src.off) * cc; viaNode = -9; }
      if (t.off <= src.off && (g.segDir[t.seg] & 2) && (src.off - t.off) * cc < best) { best = (src.off - t.off) * cc; viaNode = -9; }
    }
    if ((g.segDir[t.seg] & 1) && g.done[a] === run && g.dist[a] + t.off * cc < best) { best = g.dist[a] + t.off * cc; viaNode = a; }
    if ((g.segDir[t.seg] & 2) && g.done[b] === run && g.dist[b] + (g.segLen[t.seg] - t.off) * cc < best) { best = g.dist[b] + (g.segLen[t.seg] - t.off) * cc; viaNode = b; }
    if (viaNode === -9) {
      pieces.push({ seg: t.seg, from: src.off, to: t.off });
    } else {
      pieces.push({ seg: t.seg, from: viaNode === a ? 0 : g.segLen[t.seg], to: t.off, node: viaNode });
      var u = viaNode, guard = 0;
      while (guard++ < 1e6) {
        var ps = g.prevSeg[u];
        if (ps <= -2) {
          var ss = -2 - ps; // 出発区間
          pieces.push({ seg: ss, from: src.off, to: g.prevRev[u] ? 0 : g.segLen[ss] });
          break;
        }
        var rv = g.prevRev[u];
        pieces.push({ seg: ps, from: rv ? g.segLen[ps] : 0, to: rv ? 0 : g.segLen[ps], node: rv ? g.segA[ps] : g.segB[ps] });
        u = rv ? g.segB[ps] : g.segA[ps];
      }
      pieces.reverse();
    }
    // 座標と案内を組み立てる
    var coords = [], cum = [], steps = [], acc = 0;
    var dist = 0;
    for (var p = 0; p < pieces.length; p++) {
      var pc = pieces[p];
      var part = segPart(g, pc.seg, pc.from, pc.to);
      for (var q = 0; q < part.length; q++) {
        if (coords.length) {
          var last = coords[coords.length - 1];
          var d = hav(last[0], last[1], part[q][0], part[q][1]);
          if (d < 0.05 && q === 0) continue;
          acc += d;
        }
        coords.push(part[q]); cum.push(acc);
      }
      pc.endDist = acc;
      dist += Math.abs(pc.to - pc.from);
    }
    for (p = 0; p < pieces.length - 1; p++) {
      var cur = pieces[p], nxt = pieces[p + 1];
      var node = cur.to === 0 ? g.segA[cur.seg] : g.segB[cur.seg];
      var inB = pieceBearing(g, cur, true), outB = pieceBearing(g, nxt, false);
      var turn = ((outB - inB + 540) % 360) - 180; // 右が正
      var deg = g.nodeDeg[node];
      var nameCur = g.segName[cur.seg], nameNxt = g.segName[nxt.seg];
      var abs = Math.abs(turn);
      if (deg <= 2 && abs < 60) continue; // 分岐のない曲がり道
      if (abs < 25) continue; // ほぼ直進
      // 選んだ道が一番まっすぐな選択肢なら「道なり」
      if (abs < 50) {
        var straightest = true;
        for (var e2 = g.adj.start[node]; e2 < g.adj.start[node + 1]; e2++) {
          var sg2 = g.adj.seg[e2];
          if (sg2 === cur.seg || sg2 === nxt.seg) continue;
          var rv2 = g.adj.rev[e2];
          var ob = pieceBearing(g, { seg: sg2, from: rv2 ? g.segLen[sg2] : 0, to: rv2 ? 0 : g.segLen[sg2] }, false);
          var t2 = Math.abs(((ob - inB + 540) % 360) - 180);
          if (t2 < abs) { straightest = false; break; }
        }
        if (straightest) continue;
      }
      var type = abs >= 150 ? 'uturn' : abs >= 60 ? (turn > 0 ? 'right' : 'left') : (turn > 0 ? 'slight_right' : 'slight_left');
      steps.push({ dist: cur.endDist, lat: g.nodeLat[node] / 1e6, lng: g.nodeLng[node] / 1e6, type: type, turn: Math.round(turn),
        name: nameNxt >= 0 ? g.names[nameNxt] : '', fromName: nameCur >= 0 ? g.names[nameCur] : '' });
    }
    steps.push({ dist: acc, lat: dst.lat, lng: dst.lng, type: 'arrive', turn: 0, name: '' });
    return { coords: coords, cum: cum, steps: steps, distance: acc, duration: total };
  }
  function pieceBearing(g, pc, atEnd) {
    var len = Math.abs(pc.to - pc.from);
    var span = Math.min(25, len);
    var p1, p2;
    if (atEnd) {
      var dirSign = pc.to >= pc.from ? 1 : -1;
      p1 = segPart(g, pc.seg, pc.to - dirSign * span, pc.to);
    } else {
      var ds = pc.to >= pc.from ? 1 : -1;
      p1 = segPart(g, pc.seg, pc.from, pc.from + ds * span);
    }
    var a = p1[0], b = p1[p1.length - 1];
    return bearing(a[0], a[1], b[0], b[1]);
  }

  /* ---------- 所要時間の表 ---------- */
  function matrix(g, snaps, onProgress) {
    var n = snaps.length;
    var M = new Float64Array(n * n);
    for (var i = 0; i < n; i++) {
      if (!snaps[i]) { for (var j = 0; j < n; j++) M[i * n + j] = i === j ? 0 : 1e7; continue; }
      var row = dijkstra(g, snaps[i], snaps, false);
      for (j = 0; j < n; j++) M[i * n + j] = i === j ? 0 : (isFinite(row[j]) ? row[j] : 1e7);
      if (onProgress) onProgress(i + 1, n);
    }
    return M;
  }

  /* ---------- 巡回順の最適化（非対称 TSP、0 は出発地） ----------
   * ids: 回る地点の番号（M の添字）, start: 出発の添字, end: 戻る添字 or -1（どこで終わってもよい） */
  function solveTSP(M, n, start, ids, end, timeLimitMs) {
    if (ids.length <= 1) return ids.slice();
    var deadline = Date.now() + (timeLimitMs || 2000);
    function c(a, b) { return M[a * n + b]; }
    // 最近傍法
    var left = ids.slice(), tour = [], cur = start;
    while (left.length) {
      var bi = 0;
      for (var k = 1; k < left.length; k++) if (c(cur, left[k]) < c(cur, left[bi])) bi = k;
      cur = left[bi]; tour.push(cur); left.splice(bi, 1);
    }
    function full(t) { var a = [start].concat(t); if (end >= 0) a.push(end); return a; }
    function cost(t) {
      var a = full(t), s = 0;
      for (var i = 0; i < a.length - 1; i++) s += c(a[i], a[i + 1]);
      return s;
    }
    var best = cost(tour);
    var improved = true;
    while (improved && Date.now() < deadline) {
      improved = false;
      // Or-opt：1〜3 地点の塊を別の位置へ移動
      for (var segLen = 1; segLen <= 3; segLen++) {
        for (var i = 0; i + segLen <= tour.length; i++) {
          var chunk = tour.slice(i, i + segLen);
          var rest = tour.slice(0, i).concat(tour.slice(i + segLen));
          for (var j = 0; j <= rest.length; j++) {
            if (j === i) continue;
            var cand = rest.slice(0, j).concat(chunk, rest.slice(j));
            var cc = cost(cand);
            if (cc < best - 0.5) { best = cc; tour = cand; improved = true; break; }
          }
          if (Date.now() > deadline) break;
        }
      }
      // 2-opt（区間反転）
      for (i = 0; i < tour.length - 1 && Date.now() < deadline; i++) {
        for (j = i + 1; j < tour.length; j++) {
          var cand2 = tour.slice(0, i).concat(tour.slice(i, j + 1).reverse(), tour.slice(j + 1));
          var c2 = cost(cand2);
          if (c2 < best - 0.5) { best = c2; tour = cand2; improved = true; }
        }
      }
    }
    return tour;
  }

  /* 時間帯ごとに分けて順番を決める
   * meta[i-1] = {rank: 時間帯の早い順の番号（指定なしは -1）, priority}
   * 指定なしの地点は、所要時間が一番近い時間帯指定の地点と同じ組に入れる（近くを通るときに配る） */
  function solveGrouped(M, n, start, meta, end, budgetMs) {
    function c(a, b) { return M[a * n + b]; }
    var ids = [], i;
    for (i = 1; i < n; i++) ids.push(i);
    var slotted = ids.filter(function (k) { return meta[k - 1].rank >= 0; });
    var groups = {};
    ids.forEach(function (k) {
      var r = meta[k - 1].rank;
      if (r < 0) {
        if (!slotted.length) r = 0;
        else {
          var best = slotted[0], bd = Infinity;
          slotted.forEach(function (j) { var d = Math.min(c(k, j), c(j, k)); if (d < bd) { bd = d; best = j; } });
          r = meta[best - 1].rank;
        }
      }
      (groups[r] = groups[r] || []).push(k);
    });
    var ranks = Object.keys(groups).map(Number).sort(function (a, b) { return a - b; });
    var calls = ranks.length * 2, each = Math.max(200, (budgetMs || 2000) / calls);
    var order = [], cur = start;
    ranks.forEach(function (r, gi) {
      var g = groups[r], last = gi === ranks.length - 1;
      var pri = g.filter(function (k) { return meta[k - 1].priority; });
      var rest = g.filter(function (k) { return !meta[k - 1].priority; });
      if (pri.length) { var t1 = solveTSP(M, n, cur, pri, rest.length ? -1 : (last ? end : -1), each); order = order.concat(t1); cur = t1[t1.length - 1]; }
      if (rest.length) { var t2 = solveTSP(M, n, cur, rest, last ? end : -1, each); order = order.concat(t2); cur = t2[t2.length - 1]; }
    });
    return order;
  }

  var api = {
    solveGrouped: solveGrouped,
    SPEED: SPEED, CLASS_NAME: CLASS_NAME, overpassQuery: overpassQuery, splitBbox: splitBbox,
    buildGraph: buildGraph, prepare: prepare, snap: snap, dijkstra: dijkstra, route: route,
    matrix: matrix, solveTSP: solveTSP, hav: hav, bearing: bearing,
    GRAPH_KEYS: ['nodeLat', 'nodeLng', 'nodeDeg', 'segA', 'segB', 'segLen', 'segCost', 'segDir', 'segName', 'segClass', 'segGeoStart', 'segGeoLen', 'segMain', 'geo']
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.GraphCore = api;
})(this);
