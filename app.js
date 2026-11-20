/* 配達ナビ — 画面の動き */
'use strict';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const GC = window.GraphCore;
const DEMO = /[?&]demo/.test(location.search);

/* ---------- 地図の種類（ゼンリン契約後にここへ追加） ---------- */
const MAP_SOURCES = {
  gsi_std: { name: '国土地理院 標準地図', url: 'https://cyberjapandata.gsi.go.jp/xyz/std/{z}/{x}/{y}.png', max: 18,
    attr: '<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank">国土地理院</a>' },
  gsi_pale: { name: '国土地理院 淡色地図', url: 'https://cyberjapandata.gsi.go.jp/xyz/pale/{z}/{x}/{y}.png', max: 18,
    attr: '<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank">国土地理院</a>' },
  gsi_photo: { name: '国土地理院 航空写真', url: 'https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/{z}/{x}/{y}.jpg', max: 18,
    attr: '<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank">国土地理院</a>' }
  // zenrin: { name: 'ゼンリン地図', url: '契約で案内されるURL', max: 20, attr: '© ZENRIN' }
};
const PRESET_AREAS = {
  shinko: { name: '信更町とその周辺', s: 36.50, w: 138.00, n: 36.63, e: 138.13 },
  nagano: { name: '長野市とその周辺', s: 36.45, w: 137.93, n: 36.85, e: 138.38 }
};
const HOME_AREA = { city: '長野市', town: '信更町' };
const KINDS = [{ k: 'deliver', label: '配達' }, { k: 'pickup', label: '集荷' }];
const TEMPS = [{ k: '', label: '常温' }, { k: 'chill', label: '冷蔵', icon: '🧊' }, { k: 'frozen', label: '冷凍', icon: '❄️' }];
const OKIHAI = [{ k: 'ok', label: '可' }, { k: 'ng', label: '不可' }];
function stopTags(s) {
  return [s.kind === 'pickup' ? '<span class="pick">集荷</span>' : '',
    s.slot ? `<span class="slot">⏰ ${slotOf(s.slot).label}</span>` : '',
    s.temp === 'frozen' ? '<span class="cold">❄️ 冷凍</span>' : s.temp === 'chill' ? '<span class="cold">🧊 冷蔵</span>' : '',
    s.collect > 0 ? `<span class="collect">💴 コレクト ${Number(s.collect).toLocaleString()}円</span>` : '',
    s.okihai === 'ok' ? '<span class="okk">置き配 可</span>' : s.okihai === 'ng' ? '<span class="ng">置き配 不可</span>' : '<span class="warn">置き配 未確認</span>'].join('');
}
const TIME_SLOTS = [
  { k: '', label: '指定なし', short: '' }, { k: 'am', label: '午前中', short: '午前' },
  { k: '14', label: '14〜16時', short: '14-16' }, { k: '16', label: '16〜18時', short: '16-18' }, { k: '19', label: '19〜21時', short: '19-21' }
];
const slotOf = (k) => TIME_SLOTS.find((t) => t.k === (k || '')) || TIME_SLOTS[0];
const slotRank = (k) => (k ? TIME_SLOTS.findIndex((t) => t.k === k) - 1 : -1);
function slotFromText(t) {
  t = String(t || '').normalize('NFKC');
  if (/午前/.test(t)) return 'am';
  const m = t.match(/(1[2-9])\s*(時|:00)?\s*[-〜~～から]/);
  return m && TIME_SLOTS.some((x) => x.k === m[1]) ? m[1] : '';
}
const HAZARD_TYPES = { ice: { icon: '❄️', name: '凍結注意' }, chain: { icon: '⛓️', name: 'チェーン装着' }, narrow: { icon: '🚧', name: '狭い道' }, other: { icon: '⚠️', name: '注意' } };

/* ---------- 状態 ---------- */
const S = {
  settings: { v: 2, mapSource: 'gsi_std', area: Object.assign({}, PRESET_AREAS.shinko), maxZoom: 17, speech: true, voiceInput: true, lastTown: '',
    startMode: 'gps', home: null, endMode: 'open', autoCache: true },
  plans: [], planId: null, hazards: [], favorites: [],
  graphMeta: null, pos: null, nav: null, expanded: null, pick: null
};
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const plan = () => S.plans.find((p) => p.id === S.planId);

let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    DB.put('kv', 'state', { settings: S.settings, plans: S.plans, planId: S.planId, hazards: S.hazards, favorites: S.favorites }).catch((e) => toast('保存できませんでした：' + e.message));
  }, 300);
}

/* ---------- 小物 ---------- */
function fmtDist(m) {
  if (m == null || !isFinite(m)) return '--';
  if (m < 1000) return (m < 100 ? Math.round(m / 5) * 5 : Math.round(m / 10) * 10) + 'm';
  return (m / 1000).toFixed(m < 10000 ? 1 : 0) + 'km';
}
function fmtDur(sec) {
  if (sec == null || !isFinite(sec)) return '--';
  const m = Math.round(sec / 60);
  if (m < 60) return m + '分';
  return Math.floor(m / 60) + '時間' + (m % 60) + '分';
}
function speakDist(m) {
  if (m < 1000) return (m < 100 ? Math.round(m / 10) * 10 : Math.round(m / 50) * 50) + 'メートル';
  return (Math.round(m / 100) / 10) + 'キロ';
}
let toastTimer;
function toast(msg, ms) {
  const t = $('toast'); t.textContent = msg; t.classList.remove('hidden');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.add('hidden'), ms || 2800);
}
function openModal(html, onReady) {
  $('modalBox').innerHTML = html; $('modal').classList.remove('hidden');
  if (onReady) onReady($('modalBox'));
}
function closeModal() { $('modal').classList.add('hidden'); $('modalBox').innerHTML = ''; }
function ask(text, okLabel, danger) {
  return new Promise((res) => {
    openModal(`<h2>確認</h2><p>${esc(text)}</p><div class="modal-btns"><button id="mNo">やめる</button><button id="mYes" class="${danger ? 'danger' : 'primary'}">${esc(okLabel || 'OK')}</button></div>`, () => {
      $('mNo').onclick = () => { closeModal(); res(false); };
      $('mYes').onclick = () => { closeModal(); res(true); };
    });
  });
}
function openExternal(url) {
  const a = document.createElement('a'); a.href = url; a.target = '_blank'; a.rel = 'noopener';
  document.body.appendChild(a); a.click(); a.remove();
}

/* ---------- 音声 ---------- */
let lastSpeech = '';
function speak(text, force) {
  if (!S.settings.speech && !force) return;
  try {
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'ja-JP'; u.rate = 1.0;
    const v = speechSynthesis.getVoices().find((x) => /ja/i.test(x.lang));
    if (v) u.voice = v;
    if (speechSynthesis.speaking && speechSynthesis.pending) speechSynthesis.cancel(); // 古い案内がたまったら捨てる
    speechSynthesis.speak(u);
    lastSpeech = text;
  } catch (e) { /* 音声なし */ }
}

/* ---------- 裏方（Worker） ---------- */
const worker = new Worker('graph-worker.js');
let rpcSeq = 0;
const pending = new Map();
worker.onmessage = (e) => {
  const m = e.data, p = pending.get(m.id);
  if (!p) return;
  if (m.progress) { if (p.onProgress) p.onProgress(m.progress); return; }
  pending.delete(m.id);
  m.ok ? p.res(m.result) : p.rej(new Error(m.result));
};
function call(type, data, onProgress) {
  return new Promise((res, rej) => {
    const id = ++rpcSeq; pending.set(id, { res, rej, onProgress });
    worker.postMessage(Object.assign({ id, type }, data || {}));
  });
}

/* ---------- 通信状態 ---------- */
let netFailUntil = 0;
function isOnline() { return navigator.onLine && Date.now() > netFailUntil; }
function updateNet() {
  const el = $('netState');
  el.textContent = navigator.onLine ? 'オンライン' : 'オフライン';
  el.classList.toggle('off', !navigator.onLine);
}
window.addEventListener('online', updateNet);
window.addEventListener('offline', updateNet);
async function fetchTimeout(url, ms, opt) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms || 8000);
  try { return await fetch(url, Object.assign({ signal: ctl.signal }, opt || {})); } finally { clearTimeout(t); }
}

/* ---------- 地図 ---------- */
let map, baseLayer, meMarker, stopLayer, hazardLayer, routeLine, orderLine;
const tileKey = (src, z, x, y) => `${src}/${z}/${x}/${y}`;
function tileUrl(src, z, x, y) { return MAP_SOURCES[src].url.replace('{z}', z).replace('{x}', x).replace('{y}', y); }

async function getTile(src, z, x, y) {
  const b = await DB.get('tiles', tileKey(src, z, x, y)).catch(() => null);
  if (b) return { blob: b, dz: 0, ox: 0, oy: 0 };
  if (isOnline() && z <= MAP_SOURCES[src].max) {
    try {
      const r = await fetchTimeout(tileUrl(src, z, x, y), 7000);
      if (r.ok) {
        const blob = await r.blob();
        if (S.settings.autoCache) DB.put('tiles', tileKey(src, z, x, y), blob).catch(() => {});
        return { blob, dz: 0, ox: 0, oy: 0 };
      }
    } catch (e) { netFailUntil = Date.now() + 30000; }
  }
  // 保存済みの粗い地図を拡大して使う
  for (let dz = 1; dz <= 6 && z - dz >= 0; dz++) {
    const px = x >> dz, py = y >> dz;
    const pb = await DB.get('tiles', tileKey(src, z - dz, px, py)).catch(() => null);
    if (pb) return { blob: pb, dz, ox: x - (px << dz), oy: y - (py << dz) };
  }
  return null;
}
const OfflineLayer = L.GridLayer.extend({
  createTile(c, done) {
    const tile = L.DomUtil.create('div', 'otile');
    const size = this.getTileSize();
    getTile(this.options.src, c.z, c.x, c.y).then((r) => {
      if (!r) return done(null, tile);
      const img = document.createElement('img');
      const url = URL.createObjectURL(r.blob);
      const sc = 1 << r.dz;
      img.style.width = size.x * sc + 'px'; img.style.height = size.y * sc + 'px';
      img.style.left = -(r.ox * size.x) + 'px'; img.style.top = -(r.oy * size.y) + 'px';
      img.onload = img.onerror = () => { URL.revokeObjectURL(url); done(null, tile); };
      img.alt = ''; img.src = url; tile.appendChild(img);
    }).catch(() => done(null, tile));
    return tile;
  }
});
function setBaseLayer() {
  if (baseLayer) map.removeLayer(baseLayer);
  const src = MAP_SOURCES[S.settings.mapSource] ? S.settings.mapSource : 'gsi_std';
  baseLayer = new OfflineLayer({ src, maxZoom: 19, attribution: MAP_SOURCES[src].attr + ' | 道路 © <a href="https://www.openstreetmap.org/copyright" target="_blank">OpenStreetMap</a>', keepBuffer: 3 });
  baseLayer.addTo(map);
}

function initMap() {
  map = L.map('map', { zoomControl: false, maxZoom: 19, minZoom: 6 }).setView([36.6486, 138.1948], 13);
  setBaseLayer();
  stopLayer = L.layerGroup().addTo(map);
  hazardLayer = L.layerGroup().addTo(map);
  map.on('click', onMapClick);
  map.on('contextmenu', (e) => mapMenu(e.latlng));
  map.on('dragstart', () => { if (S.nav) { S.nav.follow = false; $('btnFollow').classList.remove('hidden'); } });
}
function onMapClick(e) {
  if (!S.pick) return;
  const cb = S.pick.cb; endPick(); cb(e.latlng);
}
function startPick(text, cb) {
  S.pick = { cb }; $('pickText').textContent = text; $('pickBar').classList.remove('hidden');
  $('sheet').classList.add('collapsed');
}
function endPick() { S.pick = null; $('pickBar').classList.add('hidden'); }
function mapMenu(ll) {
  if (S.nav) return;
  const div = document.createElement('div');
  div.innerHTML = `<div class="small muted">${esc(nearLabel(ll.lat, ll.lng))}</div>
    <button class="primary" data-a="stop">配達先に追加</button><button data-a="hz">注意地点に追加</button><button data-a="home">ここを出発地にする</button>`;
  const pop = L.popup().setLatLng(ll).setContent(div).openOn(map);
  div.querySelector('[data-a=stop]').onclick = () => { map.closePopup(pop); newStopDialog({ lat: ll.lat, lng: ll.lng, address: nearLabel(ll.lat, ll.lng) }); };
  div.querySelector('[data-a=hz]').onclick = () => { map.closePopup(pop); hazardDialog(ll); };
  div.querySelector('[data-a=home]').onclick = () => { map.closePopup(pop); S.settings.home = { lat: ll.lat, lng: ll.lng, label: nearLabel(ll.lat, ll.lng) }; S.settings.startMode = 'home'; save(); renderPlan(); toast('出発地を設定しました'); };
}

/* ---------- 住所データ（オフライン検索用） ---------- */
let ADDR = [];
const normAddr = (s) => String(s).normalize('NFKC').replace(/\s/g, '').replace(/^長野県/, '').replace(/大字|字/g, '').replace(/[ヶヵケが]/g, 'ケ').replace(/[の之]/g, 'ノ');
async function loadAddr() {
  try {
    const r = await fetch('addresses.json');
    ADDR = (await r.json()).map((a) => ({ city: a[0], group: a[1], leaf: a[2], town: a[1] + a[2], lat: a[3], lng: a[4], key: normAddr(a[0] + a[1] + a[2]), key2: normAddr(a[1] + a[2]) }));
  } catch (e) { ADDR = []; }
}
function offlineSearch(q) {
  const base = normAddr(q).replace(/[0-9\-−‐ー－丁目番地号]+$/, '').replace(/[0-9]+$/, '');
  if (base.length < 2) return [];
  const out = [];
  for (const a of ADDR) {
    let score = 0;
    if (base.includes(a.key)) score = 100 + a.key.length;
    else if (base.includes(a.key2) && a.key2.length >= 2) score = 80 + a.key2.length;
    else if (a.key.includes(base)) score = 60 - (a.key.length - base.length) * 0.1;
    if (score) out.push({ score, a });
  }
  out.sort((x, y) => y.score - x.score);
  return out.slice(0, 15).map(({ a }) => ({ label: a.city + a.town, lat: a.lat, lng: a.lng, approx: true, src: 'off' }));
}
async function onlineSearch(q) {
  if (!isOnline()) return [];
  try {
    const r = await fetchTimeout('https://msearch.gsi.go.jp/address-search/AddressSearch?q=' + encodeURIComponent(q), 7000);
    const js = await r.json();
    return js.slice(0, 8).map((f) => ({ label: f.properties.title, lat: f.geometry.coordinates[1], lng: f.geometry.coordinates[0], approx: false, src: 'on' }));
  } catch (e) { return []; }
}
function nearLabel(lat, lng) {
  let best = null, bd = Infinity;
  for (const a of ADDR) { const d = GC.hav(lat, lng, a.lat, a.lng); if (d < bd) { bd = d; best = a; } }
  return best && bd < 4000 ? best.city + best.town + '付近' : `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
}
async function geocode(q) {
  const on = await onlineSearch(q);
  if (on.length) return on[0];
  const off = offlineSearch(q);
  return off[0] || null;
}

/* ---------- 現在地 ---------- */
let watchId = null, wakeLock = null;
function startGeo() {
  if (watchId !== null || !navigator.geolocation) return;
  watchId = navigator.geolocation.watchPosition((p) => {
    onPosition({ lat: p.coords.latitude, lng: p.coords.longitude, acc: p.coords.accuracy, speed: p.coords.speed, heading: p.coords.heading, t: Date.now() });
  }, (err) => { if (err.code === 1) toast('位置情報の利用が許可されていません（設定 → Safari → 位置情報）', 5000); },
  { enableHighAccuracy: true, maximumAge: 2000, timeout: 20000 });
}
function onPosition(p) {
  if (S.nav && S.nav.sim && !p.sim) return; // デモ走行中は本物のGPSを無視
  S.pos = p;
  if (!meMarker) meMarker = L.marker([p.lat, p.lng], { icon: L.divIcon({ className: '', html: '<div class="me"></div>', iconSize: [22, 22] }), zIndexOffset: 1000, interactive: false }).addTo(map);
  else meMarker.setLatLng([p.lat, p.lng]);
  if (S.locateOnce) { S.locateOnce = false; map.setView([p.lat, p.lng], Math.max(map.getZoom(), 16)); }
  if (S.nav) updateNav();
}
function getPos(timeoutMs) {
  if (S.pos && Date.now() - S.pos.t < 60000) return Promise.resolve(S.pos);
  startGeo();
  return new Promise((res) => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      if (S.pos && Date.now() - S.pos.t < 60000) { clearInterval(iv); res(S.pos); }
      else if (Date.now() - t0 > (timeoutMs || 12000)) { clearInterval(iv); res(null); }
    }, 300);
  });
}
async function keepAwake() {
  try { if ('wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen'); } catch (e) { /* 非対応 */ }
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && S.nav) keepAwake(); });

/* ---------- プラン ---------- */
function newPlan(name) {
  const d = new Date();
  const p = { id: uid(), name: name || `${d.getMonth() + 1}月${d.getDate()}日のプラン`, created: Date.now(), stops: [], estimate: null };
  S.plans.unshift(p); S.planId = p.id; save(); return p;
}
function addStop(o, focus) {
  const p = plan() || newPlan();
  const s = { id: uid(), name: o.name || '', address: o.address || '', memo: o.memo || '', lat: o.lat, lng: o.lng,
    approx: !!o.approx, priority: false, slot: o.slot || '', kind: o.kind || 'deliver', temp: o.temp || '', okihai: o.okihai || '', collect: o.collect || 0, favId: o.favId || null, status: 'todo' };
  p.stops.push(s); p.estimate = null; save(); renderPlan(); renderStops();
  toast(`${p.stops.length}件目を追加しました`);
  if (focus) map.panTo([s.lat, s.lng]);
  return s;
}
function stopLabel(s) { return s.name || s.address || '名前なし'; }
function nextStopIndex(p) { return p.stops.findIndex((s) => s.status === 'todo'); }

function renderStops() {
  stopLayer.clearLayers();
  if (orderLine) { map.removeLayer(orderLine); orderLine = null; }
  const p = plan(); if (!p) return;
  const nextIdx = S.nav ? S.nav.idx : nextStopIndex(p);
  const line = [];
  p.stops.forEach((s, i) => {
    const cls = s.status === 'done' ? 'done' : s.status === 'skip' ? 'skip' : i === nextIdx ? 'next' : '';
    const m = L.marker([s.lat, s.lng], { draggable: !S.nav && S.dragId === s.id, icon: L.divIcon({ className: '', html: `<div class="pin ${cls} ${s.kind === 'pickup' ? 'pickup' : ''}"><span>${i + 1}</span></div>${s.slot ? `<div class="slotb">${slotOf(s.slot).short}</div>` : ''}${s.temp ? `<div class="tempb">${s.temp === 'frozen' ? '❄️' : '🧊'}</div>` : ''}`, iconSize: [32, 32], iconAnchor: [4, 34] }) });
    m.on('click', () => { if (S.nav) return; S.expanded = s.id; showTab('plan'); renderPlan(); $('sheet').classList.remove('collapsed'); const el = document.querySelector(`[data-sid="${s.id}"]`); if (el) el.scrollIntoView({ block: 'center' }); });
    m.on('dragend', () => { const ll = m.getLatLng(); s.lat = ll.lat; s.lng = ll.lng; s.approx = false; p.estimate = null; S.dragId = null; save(); renderPlan(); renderStops(); toast('位置を直しました'); });
    m.addTo(stopLayer);
    if (s.status !== 'done') line.push([s.lat, s.lng]);
  });
  if (!S.nav && line.length > 1 && p.estimate) orderLine = L.polyline(line, { color: '#14213d', weight: 3, opacity: .6, dashArray: '6 8' }).addTo(map);
}
function renderHazards() {
  hazardLayer.clearLayers();
  S.hazards.forEach((h) => {
    const t = HAZARD_TYPES[h.type] || HAZARD_TYPES.other;
    L.marker([h.lat, h.lng], { icon: L.divIcon({ className: '', html: `<div class="hz">${t.icon}</div>`, iconSize: [26, 26] }) })
      .bindPopup(`<b>${esc(t.name)}</b><br>${esc(h.memo || '')}<br><button data-hz="${h.id}">削除</button>`)
      .on('popupopen', (e) => { const b = e.popup.getElement().querySelector('[data-hz]'); if (b) b.onclick = () => { S.hazards = S.hazards.filter((x) => x.id !== h.id); save(); renderHazards(); map.closePopup(); }; })
      .addTo(hazardLayer);
  });
}
function hazardDialog(ll) {
  openModal(`<h2>注意地点を追加</h2><div class="small muted">${esc(nearLabel(ll.lat, ll.lng))}</div>
    <label>種類</label><select id="hzType">${Object.entries(HAZARD_TYPES).map(([k, v]) => `<option value="${k}">${v.icon} ${v.name}</option>`).join('')}</select>
    <label>メモ（読み上げます）</label><input id="hzMemo" placeholder="例：日陰で朝は凍る">
    <div class="modal-btns"><button id="hzNo">やめる</button><button id="hzOk" class="primary">追加</button></div>`, () => {
    $('hzNo').onclick = closeModal;
    $('hzOk').onclick = () => { S.hazards.push({ id: uid(), lat: ll.lat, lng: ll.lng, type: $('hzType').value, memo: $('hzMemo').value.trim() }); save(); renderHazards(); closeModal(); toast('注意地点を追加しました'); };
  });
}

function renderPlan() {
  const el = $('pane-plan');
  let p = plan();
  if (!p) { el.innerHTML = `<p>まだプランがありません。</p><button class="primary" id="pNew">新しいプランを作る</button>`; $('pNew').onclick = () => { newPlan(); renderPlan(); }; return; }
  const total = p.stops.length, done = p.stops.filter((s) => s.status === 'done').length;
  const startText = S.settings.startMode === 'home' && S.settings.home ? '出発地：' + S.settings.home.label : '出発地：現在地';
  el.innerHTML = `
    <div class="row"><select id="pSel">${S.plans.map((x) => `<option value="${x.id}" ${x.id === p.id ? 'selected' : ''}>${esc(x.name)}（${x.stops.length}件）</option>`).join('')}</select></div>
    <div class="summary" style="margin-top:8px">
      <div><b>${total}</b> 件　完了 ${done}　残り ${total - done}</div>
      ${p.stops.some((s) => s.collect > 0) ? `<div class="small">💴 コレクト 合計 ${p.stops.reduce((a, s) => a + (s.collect || 0), 0).toLocaleString()}円（受け取り済み ${p.stops.filter((s) => s.status === 'done').reduce((a, s) => a + (s.collect || 0), 0).toLocaleString()}円）</div>` : ''}
      <div class="small">${p.estimate ? `回る時間の目安 約${fmtDur(p.estimate.totalSec)}（${p.estimate.road ? '道路データで計算' : '直線距離で概算'}）` : '「順番を決める」で回る順番を自動で決めます'}</div>
    </div>
    <div class="btngrid">
      <button class="accent" id="pOpt" ${total - done < 2 ? 'disabled' : ''}>順番を決める</button>
      <button class="ok" id="pNav" ${total - done < 1 ? 'disabled' : ''}>ナビ開始</button>
      <button id="pAdd">＋ 地点を追加</button>
      <button id="pBulk">まとめて登録</button>
    </div>
    <div class="row small"><span class="muted">${esc(startText)}／終わり：${S.settings.endMode === 'return' ? '出発地に戻る' : '最後の配達先'}</span><button id="pRoute" style="flex:0 0 auto">変更</button></div>
    <div id="stopList">${p.stops.map((s, i) => stopRow(p, s, i)).join('') || '<p class="muted">配達先がまだありません。「＋ 地点を追加」から登録してください。地図を長押ししても追加できます。</p>'}</div>
    <h3>このプラン</h3>
    <div class="btngrid"><button id="pNew2">新しいプラン</button><button id="pRename">名前を変える</button><button id="pReset">完了を全部戻す</button><button id="pDel" class="danger">プランを削除</button></div>`;
  $('pSel').onchange = (e) => { S.planId = e.target.value; S.expanded = null; save(); renderPlan(); renderStops(); };
  $('pOpt').onclick = optimizePlan;
  $('pNav').onclick = () => startNav(false);
  $('pAdd').onclick = () => showTab('add');
  $('pBulk').onclick = bulkDialog;
  $('pRoute').onclick = routeSettingsDialog;
  $('pNew2').onclick = () => { newPlan(); renderPlan(); renderStops(); };
  $('pRename').onclick = () => openModal(`<h2>プランの名前</h2><input id="rnName" value="${esc(p.name)}"><div class="modal-btns"><button id="rnNo">やめる</button><button id="rnOk" class="primary">決定</button></div>`, () => {
    $('rnNo').onclick = closeModal; $('rnOk').onclick = () => { p.name = $('rnName').value.trim() || p.name; save(); closeModal(); renderPlan(); };
  });
  $('pReset').onclick = async () => { if (await ask('このプランの完了・あとでの印を全部「未配達」に戻しますか？', '戻す')) { p.stops.forEach((s) => { s.status = 'todo'; }); save(); renderPlan(); renderStops(); } };
  $('pDel').onclick = async () => {
    if (!(await ask(`「${p.name}」を削除しますか？元に戻せません。`, '削除する', true))) return;
    S.plans = S.plans.filter((x) => x.id !== p.id); S.planId = S.plans[0] ? S.plans[0].id : null; save(); renderPlan(); renderStops();
  };
  el.querySelectorAll('.stop').forEach((row) => { row.onclick = () => { S.expanded = S.expanded === row.dataset.sid ? null : row.dataset.sid; renderPlan(); }; });
  el.querySelectorAll('[data-act]').forEach((b) => { b.onclick = (ev) => { ev.stopPropagation(); stopAction(b.dataset.act, b.dataset.id); }; });
}
function stopRow(p, s, i) {
  const nextIdx = nextStopIndex(p);
  const cls = s.status === 'done' ? 'done' : s.status === 'skip' ? 'skip' : i === nextIdx ? 'next' : '';
  const tags = [stopTags(s), s.priority ? '<span class="pri">先に回る</span>' : '', s.approx ? '<span class="warn">位置はおおよそ（「位置を直す」で修正）</span>' : '', s.status === 'skip' ? '<span>あとで</span>' : ''].join('');
  let html = `<div class="stop ${cls}" data-sid="${s.id}"><div class="num">${i + 1}</div><div class="body">
    <div class="name">${esc(stopLabel(s))}</div>${s.name && s.address ? `<div class="addr">${esc(s.address)}</div>` : ''}
    ${s.memo ? `<div class="addr">📝 ${esc(s.memo)}</div>` : ''}<div class="tags">${tags}</div></div></div>`;
  if (S.expanded === s.id) {
    html += `<div class="stop-actions">
      <button data-act="show" data-id="${s.id}">地図で見る</button>
      <button data-act="up" data-id="${s.id}">↑</button><button data-act="down" data-id="${s.id}">↓</button>
      <button data-act="edit" data-id="${s.id}">編集</button>
      <button data-act="move" data-id="${s.id}">位置を直す</button>
      <button data-act="pri" data-id="${s.id}">${s.priority ? '先に回るを外す' : '先に回る'}</button>
      <button data-act="done" data-id="${s.id}">${s.status === 'done' ? '未配達に戻す' : '完了にする'}</button>
      <button data-act="navhere" data-id="${s.id}">ここからナビ</button>
      <button data-act="del" data-id="${s.id}" class="danger">削除</button></div>`;
  }
  return html;
}
async function stopAction(act, id) {
  const p = plan(); const i = p.stops.findIndex((s) => s.id === id); if (i < 0) return;
  const s = p.stops[i];
  if (act === 'show') { map.setView([s.lat, s.lng], 17); $('sheet').classList.add('collapsed'); return; }
  if (act === 'up' && i > 0) { p.stops.splice(i - 1, 0, p.stops.splice(i, 1)[0]); p.estimate = null; }
  if (act === 'down' && i < p.stops.length - 1) { p.stops.splice(i + 1, 0, p.stops.splice(i, 1)[0]); p.estimate = null; }
  if (act === 'pri') s.priority = !s.priority;
  if (act === 'done') s.status = s.status === 'done' ? 'todo' : 'done';
  if (act === 'del') { if (!(await ask(`「${stopLabel(s)}」を削除しますか？`, '削除', true))) return; p.stops.splice(i, 1); }
  if (act === 'edit') return editStopDialog(s);
  if (act === 'move') { S.dragId = s.id; renderStops(); map.setView([s.lat, s.lng], 18); $('sheet').classList.add('collapsed'); return toast('番号の印を指で押さえたまま、正しい場所へ動かしてください', 5000); }
  if (act === 'navhere') {
    // この地点より前の未配達を「あとで」に回さず、順番の先頭へ移動
    p.stops.splice(i, 1); const first = nextStopIndex(p); p.stops.splice(first < 0 ? p.stops.length : first, 0, s); s.status = 'todo';
    save(); renderPlan(); renderStops(); return startNav(false);
  }
  save(); renderPlan(); renderStops();
}
/* ---------- 選択ボタン（時間帯・種別・温度帯・置き配） ---------- */
function chips(id, options, cur) {
  return `<div class="slots" id="${id}">${options.map((t) => `<button type="button" data-v="${t.k}" class="${(cur || '') === t.k ? 'on' : ''}">${t.icon ? t.icon + ' ' : ''}${t.label}</button>`).join('')}</div>`;
}
function bindChips(id) {
  document.querySelectorAll(`#${id} [data-v]`).forEach((b) => {
    b.onclick = () => { document.querySelectorAll(`#${id} [data-v]`).forEach((x) => x.classList.remove('on')); b.classList.add('on'); $(id).classList.remove('need'); };
  });
}
function chipVal(id) { const b = document.querySelector(`#${id} .on`); return b ? b.dataset.v : ''; }
function micBtn(target) { return S.settings.voiceInput ? `<button type="button" class="mic" data-mic="${target}" title="音声で入力">🎤</button>` : ''; }
function withMic(inputHtml, id) { return S.settings.voiceInput ? `<div class="microw">${inputHtml}${micBtn(id)}</div>` : inputHtml; }
let recog = null;
function bindMics(root) {
  (root || document).querySelectorAll('[data-mic]').forEach((b) => {
    b.onclick = () => {
      const input = $(b.dataset.mic);
      const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
      if (!SR) { input.focus(); return toast('キーボードのマイクボタン🎤を押して話してください', 4500); }
      if (recog) { try { recog.stop(); } catch (e) { /* なし */ } recog = null; b.classList.remove('rec'); return; }
      recog = new SR(); recog.lang = 'ja-JP'; recog.interimResults = false; recog.continuous = false;
      b.classList.add('rec'); toast('話してください…', 2500);
      recog.onresult = (e) => {
        const t = Array.from(e.results).map((r) => r[0].transcript).join('');
        input.value = (input.value ? input.value + ' ' : '') + t; input.dispatchEvent(new Event('input'));
      };
      recog.onerror = (e) => { toast(e.error === 'not-allowed' ? 'マイクの利用が許可されていません' : 'うまく聞き取れませんでした。キーボードのマイク🎤もお使いください', 4000); };
      recog.onend = () => { b.classList.remove('rec'); recog = null; };
      try { recog.start(); } catch (e) { b.classList.remove('rec'); recog = null; input.focus(); toast('キーボードのマイクボタン🎤を押して話してください', 4500); }
    };
  });
}

/* 配達先の入力欄（追加と編集で共通） */
function stopFormHtml(s, isNew) {
  return `
    <label>種別</label>${chips('fKind', KINDS, s.kind || 'deliver')}
    <label>時間帯</label>${chips('fSlot', TIME_SLOTS, s.slot || '')}
    <label>温度帯</label>${chips('fTemp', TEMPS, s.temp || '')}
    <label class="collect-row">コレクト（代引き）の金額</label><div class="microw yen"><input id="fCollect" inputmode="numeric" pattern="[0-9]*" placeholder="なければ空欄" value="${s.collect ? s.collect : ''}"><span>円</span></div>
    <label>置き配 <span class="req">必須</span></label>${chips('fOki', OKIHAI, s.okihai || '')}
    <label>名前</label>${withMic(`<input id="fName" value="${esc(s.name || '')}" placeholder="例：山田様">`, 'fName')}
    <label>住所</label>${withMic(`<input id="fAddr" value="${esc(s.address || '')}">`, 'fAddr')}
    <label>詳しい情報（置き場所・建物・注意など）</label>${withMic(`<textarea id="fMemo" rows="3" placeholder="例：玄関横の宅配ボックス／犬がいる／坂の上の青い屋根">${esc(s.memo || '')}</textarea>`, 'fMemo')}
    ${isNew ? `<label style="display:flex;gap:10px;align-items:center;color:var(--text)"><input type="checkbox" id="fFav" style="width:24px;height:24px" checked> よく使う住所に保存する</label>` : ''}`;
}
function bindStopForm(box) { ['fKind', 'fSlot', 'fTemp', 'fOki'].forEach(bindChips); bindMics(box); }
function readStopForm() {
  const okihai = chipVal('fOki');
  if (!okihai) { $('fOki').classList.add('need'); $('fOki').scrollIntoView({ block: 'center' }); toast('置き配の「可」か「不可」を選んでください'); return null; }
  return { kind: chipVal('fKind') || 'deliver', slot: chipVal('fSlot'), temp: chipVal('fTemp'), okihai,
    collect: parseInt(($('fCollect') ? $('fCollect').value : '').normalize('NFKC').replace(/[^0-9]/g, ''), 10) || 0, name: $('fName').value.trim(), address: $('fAddr').value.trim(), memo: $('fMemo').value.trim(), fav: $('fFav') ? $('fFav').checked : false };
}
function newStopDialog(o) {
  openModal(`<h2>${o.fromFav ? 'よく使う住所から追加' : '配達先を追加'}</h2>${stopFormHtml(o, true)}
    <div class="modal-btns"><button id="nsNo">やめる</button><button id="nsOk" class="primary">追加</button></div>`, (box) => {
    bindStopForm(box);
    $('nsNo').onclick = closeModal;
    $('nsOk').onclick = () => {
      const f = readStopForm(); if (!f) return;
      const data = Object.assign({}, o, f);
      addStop(data, true);
      if (f.fav) saveFavorite(data);
      closeModal();
    };
  });
}
function editStopDialog(s) {
  openModal(`<h2>配達先の編集</h2>${stopFormHtml(s, false)}
    <p class="small muted">位置を直すときは、一覧の「位置を直す」を押してから地図の印を動かしてください。</p>
    <div class="modal-btns"><button id="eNo">やめる</button><button id="eOk" class="primary">保存</button></div>`, (box) => {
    bindStopForm(box);
    $('eNo').onclick = closeModal;
    $('eOk').onclick = () => {
      const f = readStopForm(); if (!f) return;
      if (s.slot !== f.slot) { const p = plan(); if (p) p.estimate = null; }
      Object.assign(s, { kind: f.kind, slot: f.slot, temp: f.temp, okihai: f.okihai, collect: f.collect, name: f.name, address: f.address, memo: f.memo });
      updateFavoriteFromStop(s);
      save(); closeModal(); renderPlan(); renderStops();
    };
  });
}

/* ---------- よく使う住所 ---------- */
const favKey = (o) => normAddr((o.address || '') + '|' + (o.name || ''));
function findFavorite(o) {
  return S.favorites.find((f) => favKey(f) === favKey(o)) ||
    S.favorites.find((f) => (f.name || '') === (o.name || '') && GC.hav(f.lat, f.lng, o.lat, o.lng) < 15);
}
function saveFavorite(o) {
  const ex = findFavorite(o);
  const fields = { address: o.address || '', name: o.name || '', lat: o.lat, lng: o.lng, okihai: o.okihai || '', temp: o.temp || '', kind: o.kind || 'deliver', memo: o.memo || '' };
  if (ex) { Object.assign(ex, fields); ex.uses = (ex.uses || 0) + 1; ex.last = Date.now(); }
  else S.favorites.push(Object.assign({ id: uid(), uses: 1, last: Date.now() }, fields));
  save();
}
function updateFavoriteFromStop(s) {
  const ex = s.favId ? S.favorites.find((f) => f.id === s.favId) : findFavorite(s);
  if (ex) { Object.assign(ex, { address: s.address, name: s.name, okihai: s.okihai, temp: s.temp, kind: s.kind, memo: s.memo, lat: s.lat, lng: s.lng }); save(); }
}
function favList(filter) {
  const q = normAddr(filter || '');
  return S.favorites.filter((f) => !q || normAddr(f.name + f.address + f.memo).includes(q))
    .sort((a, b) => (b.uses || 0) - (a.uses || 0) || (b.last || 0) - (a.last || 0));
}
function favRow(f) {
  return `<div class="result fav" data-fav="${f.id}"><b>${esc(f.name || f.address)}</b>${f.name ? `<div class="small muted">${esc(f.address)}</div>` : ''}
    <div class="tags">${stopTags(f)}</div></div>`;
}
function favManager() {
  const draw = () => {
    const list = favList($('fmQ') ? $('fmQ').value : '');
    $('fmList').innerHTML = list.length ? list.map((f) => `<div class="stop"><div class="body"><div class="name">${esc(f.name || f.address)}</div>${f.name ? `<div class="addr">${esc(f.address)}</div>` : ''}${f.memo ? `<div class="addr">📝 ${esc(f.memo)}</div>` : ''}<div class="tags">${stopTags(f)}</div></div>
      <div style="display:flex;flex-direction:column;gap:4px"><button data-fe="${f.id}">編集</button><button data-fd="${f.id}" class="danger">削除</button></div></div>`).join('') : '<p class="muted">まだありません。配達先を登録すると、自動でここに入ります。</p>';
    $('fmList').querySelectorAll('[data-fe]').forEach((b) => { b.onclick = () => favEdit(S.favorites.find((x) => x.id === b.dataset.fe)); });
    $('fmList').querySelectorAll('[data-fd]').forEach((b) => { b.onclick = async () => { const f = S.favorites.find((x) => x.id === b.dataset.fd); if (await ask(`「${f.name || f.address}」をよく使う住所から削除しますか？`, '削除', true)) { S.favorites = S.favorites.filter((x) => x.id !== f.id); save(); } favManager(); }; });
  };
  openModal(`<h2>よく使う住所（${S.favorites.length}件）</h2><input id="fmQ" placeholder="名前や住所で絞り込み"><div id="fmList"></div>
    <div class="modal-btns"><button id="fmClose">閉じる</button></div>`, () => { $('fmClose').onclick = () => { closeModal(); if (!$('pane-add').classList.contains('hidden')) renderAdd(); }; $('fmQ').oninput = draw; draw(); });
}
function favEdit(f) {
  openModal(`<h2>よく使う住所の編集</h2>${stopFormHtml(f, false).replace(/<label>時間帯<\/label>[\s\S]*?<\/div>/, '').replace(/<label class="collect-row">[\s\S]*?<\/div>/, '')}
    <div class="modal-btns"><button id="feNo">戻る</button><button id="feOk" class="primary">保存</button></div>`, (box) => {
    bindStopForm(box);
    $('feNo').onclick = favManager;
    $('feOk').onclick = () => { const v = readStopForm(); if (!v) return; Object.assign(f, { kind: v.kind, temp: v.temp, okihai: v.okihai, name: v.name, address: v.address, memo: v.memo }); save(); toast('保存しました'); favManager(); };
  });
}

/* ---------- 地点を追加 ---------- */
function renderAdd() {
  const towns = ADDR.filter((a) => a.city === HOME_AREA.city && a.group === HOME_AREA.town);
  const lastTown = S.settings.lastTown || '氷ノ田';
  const favs = favList('').slice(0, 30);
  $('pane-add').innerHTML = `
    <h3>住所を選んで追加</h3>
    <div class="row"><b style="flex:0 0 auto">${esc(HOME_AREA.city + HOME_AREA.town)}</b><select id="adTown">${towns.map((t) => `<option ${t.leaf === lastTown ? 'selected' : ''}>${esc(t.leaf)}</option>`).join('')}</select></div>
    <label>番地</label>${withMic('<input id="adNum" inputmode="text" placeholder="例：1234-5">', 'adNum')}
    <label>名前</label>${withMic('<input id="adName" placeholder="例：山田様">', 'adName')}
    <button id="adGo" class="primary" style="width:100%;margin-top:10px">この住所で追加</button>
    <h3>よく使う住所（${S.favorites.length}件）</h3>
    ${S.favorites.length ? `${withMic('<input id="fvQ" placeholder="名前や住所で探す">', 'fvQ')}<div id="fvList">${favs.map(favRow).join('')}</div><button id="fvManage" style="width:100%;margin-top:8px">よく使う住所を編集する</button>` : '<p class="small muted">一度登録した住所は、自動でここに入ります。次からはタップするだけで追加できます。</p>'}
    <h3>ほかの方法で探す</h3>
    ${withMic('<input id="aQ" placeholder="ほかの地域の住所や地名" enterkeyhint="search">', 'aQ')}
    <button id="aGo" style="width:100%;margin-top:6px">検索</button>
    <div id="aRes"></div>
    <div class="btngrid" style="margin-top:10px"><button id="aMap">地図をタップして追加</button><button id="aHere">今いる場所を追加</button><button id="aBulk">まとめて登録</button><button id="aHz">注意地点を追加</button></div>`;
  bindMics($('pane-add'));
  $('adGo').onclick = async () => {
    const town = $('adTown').value, num = $('adNum').value.trim().normalize('NFKC'), name = $('adName').value.trim();
    S.settings.lastTown = town; save();
    const address = HOME_AREA.city + HOME_AREA.town + town + (num ? ' ' + num : '');
    const base = towns.find((t) => t.leaf === town);
    let pos = { lat: base.lat, lng: base.lng, approx: true };
    if (num && isOnline()) {
      $('adGo').disabled = true; $('adGo').textContent = '場所を調べています…';
      const on = await onlineSearch(address.replace(' ', ''));
      const hit = on.find((r) => r.label.includes(town) && /\d/.test(r.label));
      if (hit) pos = { lat: hit.lat, lng: hit.lng, approx: false };
      $('adGo').disabled = false; $('adGo').textContent = 'この住所で追加';
    }
    const fav = findFavorite({ address, name, lat: pos.lat, lng: pos.lng });
    map.setView([pos.lat, pos.lng], 17);
    newStopDialog(Object.assign({ address, name }, fav ? { okihai: fav.okihai, temp: fav.temp, kind: fav.kind, memo: fav.memo, lat: fav.lat, lng: fav.lng, approx: false, favId: fav.id } : pos));
    if (pos.approx && !fav) toast('番地の位置までは分からないため、地名の中心に置きます。あとで「位置を直す」で直せます', 6000);
  };
  const bindFavRows = () => document.querySelectorAll('#fvList [data-fav]').forEach((d) => {
    d.onclick = () => { const f = S.favorites.find((x) => x.id === d.dataset.fav); map.setView([f.lat, f.lng], 17); newStopDialog({ fromFav: true, favId: f.id, address: f.address, name: f.name, lat: f.lat, lng: f.lng, okihai: f.okihai, temp: f.temp, kind: f.kind, memo: f.memo }); };
  });
  bindFavRows();
  if ($('fvQ')) $('fvQ').oninput = () => { $('fvList').innerHTML = favList($('fvQ').value).slice(0, 30).map(favRow).join('') || '<p class="muted">見つかりません</p>'; bindFavRows(); };
  if ($('fvManage')) $('fvManage').onclick = favManager;
  const go = async () => {
    const q = $('aQ').value.trim(); if (!q) return;
    $('aRes').innerHTML = '<p class="muted">検索中…</p>';
    const [on, off] = [await onlineSearch(q), offlineSearch(q)];
    const list = on.concat(off);
    $('aRes').innerHTML = list.length ? list.map((r, i) => `<div class="result" data-i="${i}"><span class="src ${r.src === 'off' ? 'off' : ''}">${r.src === 'off' ? '町名' : '住所'}</span>${esc(r.label)}</div>`).join('')
      : '<p class="muted">見つかりませんでした。「地図をタップして追加」もお使いください。</p>';
    $('aRes').querySelectorAll('.result').forEach((d) => {
      d.onclick = () => { const r = list[+d.dataset.i]; map.setView([r.lat, r.lng], 17); newStopDialog({ address: /\d/.test(q) && r.approx ? q : r.label, lat: r.lat, lng: r.lng, approx: r.approx }); };
    });
  };
  $('aGo').onclick = go;
  $('aQ').onkeydown = (e) => { if (e.key === 'Enter') go(); };
  $('aMap').onclick = () => startPick('配達先をタップしてください', (ll) => newStopDialog({ lat: ll.lat, lng: ll.lng, address: nearLabel(ll.lat, ll.lng) }));
  $('aHere').onclick = async () => { const p = await getPos(); if (!p) return toast('現在地が分かりません'); newStopDialog({ lat: p.lat, lng: p.lng, address: nearLabel(p.lat, p.lng) }); };
  $('aBulk').onclick = bulkDialog;
  $('aHz').onclick = () => startPick('注意地点をタップしてください', hazardDialog);
}

function routeSettingsDialog() {
  const st = S.settings;
  openModal(`<h2>出発地と終わり</h2>
    <label>出発地</label><select id="rsStart"><option value="gps">現在地</option><option value="home" ${st.startMode === 'home' ? 'selected' : ''}>決まった場所${st.home ? '（' + esc(st.home.label) + '）' : '（未設定）'}</option></select>
    <button id="rsPick" style="margin-top:8px;width:100%">決まった場所を地図で選ぶ</button>
    <label>終わり</label><select id="rsEnd"><option value="open">最後の配達先で終わる</option><option value="return" ${st.endMode === 'return' ? 'selected' : ''}>出発地に戻る</option></select>
    <div class="modal-btns"><button id="rsNo">やめる</button><button id="rsOk" class="primary">決定</button></div>`, () => {
    $('rsNo').onclick = closeModal;
    $('rsPick').onclick = () => { closeModal(); startPick('出発地をタップしてください', (ll) => { st.home = { lat: ll.lat, lng: ll.lng, label: nearLabel(ll.lat, ll.lng) }; st.startMode = 'home'; save(); renderPlan(); toast('出発地を設定しました'); }); };
    $('rsOk').onclick = () => { st.startMode = $('rsStart').value === 'home' && st.home ? 'home' : 'gps'; st.endMode = $('rsEnd').value; if (plan()) plan().estimate = null; save(); closeModal(); renderPlan(); };
  });
}

function bulkDialog() {
  openModal(`<h2>まとめて登録</h2>
    <p class="small muted">1行に1件。「住所, 名前, メモ」の順に、カンマで区切って書けます（名前とメモはなくても大丈夫）。メモに「午前」「14-16」「冷凍」「集荷」「コレクト3500」「置き配」「置き配不可」などと書くと、その印も付きます。</p>
    <textarea id="bkText" placeholder="長野市信更町氷ノ田 123, 山田様, 午前 冷凍 置き配不可&#10;長野市信更町灰原 45, 佐藤様, 置き配 玄関前"></textarea>
    <div class="progress hidden" id="bkProg"><div></div></div><div id="bkMsg" class="small"></div>
    <div class="modal-btns"><button id="bkNo">閉じる</button><button id="bkOk" class="primary">登録する</button></div>`, () => {
    $('bkNo').onclick = closeModal;
    $('bkOk').onclick = async () => {
      const lines = $('bkText').value.split(/\n/).map((l) => l.trim()).filter(Boolean);
      if (!lines.length) return;
      $('bkOk').disabled = true; $('bkProg').classList.remove('hidden');
      let ok = 0, approx = 0; const fail = [];
      for (let i = 0; i < lines.length; i++) {
        const parts = lines[i].split(/[,，、\t]/).map((x) => x.trim());
        const r = await geocode(parts[0]);
        if (r) { addStop({ address: parts[0], name: parts[1] || '', memo: parts.slice(2).join(' '), slot: slotFromText(parts.slice(1).join(' ')), kind: /集荷/.test(lines[i]) ? 'pickup' : 'deliver', temp: /冷凍/.test(lines[i]) ? 'frozen' : /冷蔵/.test(lines[i]) ? 'chill' : '', collect: (() => { const m = lines[i].normalize('NFKC').match(/(コレクト|代引き?)\s*([0-9,]+)/); return m ? parseInt(m[2].replace(/,/g, ''), 10) : 0; })(), okihai: /置き?配\s*(不可|NG|ダメ)/i.test(lines[i]) ? 'ng' : /置き?配/.test(lines[i]) ? 'ok' : '', lat: r.lat, lng: r.lng, approx: r.approx }); ok++; if (r.approx) approx++; }
        else fail.push(parts[0]);
        $('bkProg').firstElementChild.style.width = ((i + 1) / lines.length * 100) + '%';
        $('bkMsg').textContent = `${i + 1}/${lines.length} 件を処理`;
      }
      $('bkMsg').innerHTML = `${ok}件を登録しました。${approx ? `うち${approx}件は町名までの「おおよその位置」です。地図で印を動かして直してください。` : ''}${fail.length ? `<br>見つからなかった住所：${fail.map(esc).join('、')}` : ''}`;
      $('bkOk').disabled = false; $('bkText').value = fail.join('\n');
      renderStops();
    };
  });
}

/* ---------- 順番を決める ---------- */
async function optimizePlan() {
  const p = plan(); if (!p) return;
  const todo = p.stops.filter((s) => s.status !== 'done');
  if (todo.length < 2) return toast('2件以上必要です');
  let start;
  if (S.settings.startMode === 'home' && S.settings.home) start = S.settings.home;
  else { toast('現在地を確認しています…'); start = await getPos(10000); }
  if (!start) { start = todo[0]; toast('現在地が分からないため、1件目から計算します'); }
  openModal(`<h2>順番を決めています</h2><div class="progress"><div id="opBar"></div></div><div id="opMsg" class="small">準備中…</div>`);
  let res, road = false;
  try {
    if (S.graphMeta) {
      res = await call('optimize', { opts: { start: { lat: start.lat, lng: start.lng }, stops: todo.map((s) => ({ lat: s.lat, lng: s.lng, priority: s.priority, rank: slotRank(s.slot) })), end: S.settings.endMode } }, (pr) => {
        if (pr.total) $('opBar').style.width = (pr.done / pr.total * 100) + '%';
        $('opMsg').textContent = pr.msg || '';
      });
      road = true;
    } else {
      res = straightOptimize(start, todo);
    }
  } catch (e) { closeModal(); return toast('計算できませんでした：' + e.message, 5000); }
  closeModal();
  const ordered = res.order.map((k) => todo[k]);
  p.stops = p.stops.filter((s) => s.status === 'done').concat(ordered);
  p.estimate = { totalSec: res.totalSec, road, at: Date.now() };
  save(); renderPlan(); renderStops();
  const far = (res.snapDist || []).slice(1).map((d, k) => (d != null && d > 300 ? todo[k] : null)).filter(Boolean);
  let msg = `順番を決めました。目安 約${fmtDur(res.totalSec)}`;
  if (!road) msg += '（道路データがないため直線距離で概算）';
  if (far.length) msg += `。道路から300m以上離れた地点が${far.length}件あります`;
  toast(msg, 5000);
  const b = L.latLngBounds(ordered.map((s) => [s.lat, s.lng]).concat([[start.lat, start.lng]]));
  map.fitBounds(b, { padding: [30, 30] });
}
function straightOptimize(start, stops) {
  const pts = [start].concat(stops), n = pts.length, M = new Float64Array(n * n);
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) M[i * n + j] = GC.hav(pts[i].lat, pts[i].lng, pts[j].lat, pts[j].lng) * 1.4 / 8.3;
  const end = S.settings.endMode === 'return' ? 0 : -1;
  const order = GC.solveGrouped(M, n, 0, stops.map((s) => ({ rank: slotRank(s.slot), priority: !!s.priority })), end, 1500);
  let tot = 0, prev = 0; order.forEach((k) => { tot += M[prev * n + k]; prev = k; }); if (end === 0) tot += M[prev * n];
  return { order: order.map((k) => k - 1), totalSec: tot };
}

/* ---------- ナビ ---------- */
const ARROWS = {
  straight: 'M50 8 L78 40 L60 40 L60 92 L40 92 L40 40 L22 40 Z',
  right: 'M30 92 L30 50 Q30 34 46 34 L66 34 L66 16 L94 44 L66 72 L66 54 L50 54 L50 92 Z',
  left: 'M70 92 L70 50 Q70 34 54 34 L34 34 L34 16 L6 44 L34 72 L34 54 L50 54 L50 92 Z',
  slight_right: 'M34 92 L34 56 L62 28 L50 16 L88 12 L84 50 L72 38 L54 56 L54 92 Z',
  slight_left: 'M66 92 L66 56 L38 28 L50 16 L12 12 L16 50 L28 38 L46 56 L46 92 Z',
  uturn: 'M24 92 L24 40 Q24 12 50 12 Q76 12 76 40 L76 60 L90 60 L66 88 L42 60 L56 60 L56 40 Q56 32 50 32 Q44 32 44 40 L44 92 Z',
  arrive: 'M50 6 C28 6 16 22 16 40 C16 64 50 94 50 94 C50 94 84 64 84 40 C84 22 72 6 50 6 Z M50 28 A12 12 0 1 1 49.9 28 Z'
};
const TURN_WORD = { right: '右折', left: '左折', slight_right: '斜め右', slight_left: '斜め左', uturn: 'Uターン', arrive: '目的地' };

async function startNav(sim) {
  const p = plan(); if (!p) return;
  const idx = nextStopIndex(p);
  if (idx < 0) { const sk = p.stops.findIndex((s) => s.status === 'skip'); if (sk < 0) return toast('未配達の地点がありません'); p.stops[sk].status = 'todo'; }
  speak('ナビを開始します', true); // iPhone はボタン操作の直後に一度話させる必要がある
  S.nav = { idx: nextStopIndex(p), route: null, ann: new Set(), hzAnn: new Set(), off: 0, lastReroute: 0, follow: true, sim: !!sim, arrived: false };
  $('sheet').classList.add('hidden'); $('hud').classList.add('hidden');
  $('navBanner').classList.remove('hidden'); $('navBar').classList.remove('hidden');
  $('nvVoice').textContent = S.settings.speech ? '🔊' : '🔇';
  keepAwake();
  if (!sim) startGeo();
  renderStops();
  await routeToCurrent(true);
}
function endNav() {
  if (S.nav && S.nav.simTimer) clearInterval(S.nav.simTimer);
  S.nav = null;
  if (routeLine) { map.removeLayer(routeLine); routeLine = null; }
  try { if (wakeLock) { wakeLock.release(); wakeLock = null; } } catch (e) { /* なし */ }
  speechSynthesis.cancel();
  $('sheet').classList.remove('hidden'); $('hud').classList.remove('hidden');
  $('navBanner').classList.add('hidden'); $('navBar').classList.add('hidden'); $('btnFollow').classList.add('hidden');
  renderPlan(); renderStops();
}
async function routeToCurrent(first) {
  const nav = S.nav, p = plan(); if (!nav) return;
  const target = p.stops[nav.idx];
  if (!target) return finishAll();
  $('nvNext').textContent = `${nav.idx + 1}/${p.stops.length}　${stopLabel(target)}`;
  $('nbText').textContent = 'ルートを計算中…'; $('nbDist').textContent = '--';
  let from = nav.sim ? (nav.simPos || S.pos || null) : await getPos(first ? 15000 : 5000);
  if (!from && nav.sim) from = S.settings.home || { lat: target.lat + 0.01, lng: target.lng - 0.01 };
  if (!from) { $('nbText').textContent = '現在地を待っています…'; nav.route = null; drawRoute(); return; }
  nav.from = from;
  let r = null;
  if (S.graphMeta) { try { r = await call('route', { from: { lat: from.lat, lng: from.lng }, to: { lat: target.lat, lng: target.lng } }); } catch (e) { r = null; } }
  if (!S.nav) return;
  if (!r) {
    r = { coords: [[from.lat, from.lng], [target.lat, target.lng]], cum: [0, GC.hav(from.lat, from.lng, target.lat, target.lng)], straight: true };
    r.distance = r.cum[1]; r.duration = r.distance * 1.4 / 8.3;
    r.steps = [{ dist: r.distance, lat: target.lat, lng: target.lng, type: 'arrive' }];
    if (S.graphMeta == null && first) toast('道路データがないため直線で表示しています（設定 → オフライン準備）', 5000);
  }
  nav.route = r; nav.ann = new Set(); nav.off = 0; nav.arrived = false; nav.lastIdx = 0;
  // 注意地点のルート上の位置
  nav.hz = S.hazards.map((h) => { const pr = projectOnRoute(r, h.lat, h.lng); return pr && pr.d < 40 ? { h, along: pr.along } : null; }).filter(Boolean);
  drawRoute();
  if (first) {
    speak(`${stopLabel(target)}まで、${speakDist(r.distance)}です`);
  }
  if (nav.sim && !nav.simTimer) startSim();
  updateNav();
}
function drawRoute() {
  if (routeLine) { map.removeLayer(routeLine); routeLine = null; }
  const r = S.nav && S.nav.route; if (!r) return;
  routeLine = L.polyline(r.coords, { color: r.straight ? '#c8442f' : '#1a73e8', weight: 8, opacity: .8, dashArray: r.straight ? '10 10' : null }).addTo(map);
  if (S.nav.follow) map.fitBounds(routeLine.getBounds(), { padding: [40, 40], maxZoom: 17 });
}
function projectOnRoute(r, lat, lng, fromIdx) {
  const c = r.coords, cosL = Math.cos(lat * Math.PI / 180), mx = 111320 * cosL, my = 111320;
  let best = null;
  const i0 = Math.max(0, (fromIdx || 0) - 5);
  for (let i = i0; i < c.length - 1; i++) {
    const ax = (c[i][1] - lng) * mx, ay = (c[i][0] - lat) * my, bx = (c[i + 1][1] - lng) * mx, by = (c[i + 1][0] - lat) * my;
    const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
    let u = L2 > 0 ? -(ax * dx + ay * dy) / L2 : 0; u = Math.max(0, Math.min(1, u));
    const px = ax + u * dx, py = ay + u * dy, d = Math.hypot(px, py);
    if (!best || d < best.d) best = { d, i, along: r.cum[i] + u * (r.cum[i + 1] - r.cum[i]) };
  }
  return best;
}
function updateNav() {
  const nav = S.nav, p = plan(); if (!nav || !p) return;
  const target = p.stops[nav.idx]; if (!target) return;
  const pos = nav.sim ? nav.simPos : S.pos;
  const r = nav.route;
  if (!pos || !r) return;
  if (nav.follow) map.setView([pos.lat, pos.lng], Math.max(map.getZoom(), 16), { animate: true });
  const pr = projectOnRoute(r, pos.lat, pos.lng, r.straight ? 0 : Math.max(0, (nav.lastIdx || 0) - 20));
  const along = pr ? pr.along : 0;
  if (pr) nav.lastIdx = pr.i;
  const toTarget = GC.hav(pos.lat, pos.lng, target.lat, target.lng);
  // ルートから外れた
  if (!r.straight && pr && pr.d > Math.max(45, (pos.acc || 0) * 1.3)) nav.off++; else nav.off = 0;
  if (r.straight && Date.now() - nav.lastReroute > 30000 && S.graphMeta) { nav.lastReroute = Date.now(); routeToCurrent(false); return; }
  if (nav.off >= 3 && Date.now() - nav.lastReroute > 10000) {
    nav.lastReroute = Date.now(); nav.off = 0; speak('ルートを再検索します'); routeToCurrent(false); return;
  }
  const remain = Math.max(0, r.distance - along);
  const eta = r.distance > 0 ? r.duration * remain / r.distance : 0;
  $('nvSub').textContent = `残り ${fmtDist(remain)}・約${fmtDur(eta)}`;
  $('nvDone').textContent = target.kind === 'pickup' ? '集荷完了 → 次へ' : '配達完了 → 次へ';
  $('nvTags').innerHTML = stopTags(target) + (target.memo ? `<div class="nvmemo">📝 ${esc(target.memo)}</div>` : '');
  // 到着
  if (toTarget < 40 || remain < 25) {
    setBanner('arrive', fmtDist(toTarget), '目的地付近です');
    if (!nav.arrived) { nav.arrived = true; speak(`まもなく、${stopLabel(target)}です。${target.kind === 'pickup' ? '集荷です。' : ''}${target.temp === 'frozen' ? '冷凍です。' : target.temp === 'chill' ? '冷蔵です。' : ''}${target.collect > 0 ? 'コレクト、' + target.collect + '円です。' : ''}${target.okihai === 'ng' ? '置き配はできません。' : target.okihai === 'ok' ? '置き配できます。' : ''}${target.memo ? target.memo + '。' : ''}終わったら完了を押してください`); }
    return;
  }
  // 次の案内
  const si = r.steps.findIndex((s) => s.dist > along + 3);
  const st = r.steps[si < 0 ? r.steps.length - 1 : si];
  const d = st.dist - along;
  const word = TURN_WORD[st.type] || '';
  const label = st.type === 'arrive' ? (r.straight ? '直線で表示中（道路データなし）' : '目的地まで道なり') : `${word}${st.name ? '　' + st.name : ''}`;
  setBanner(d > 1500 && st.type !== 'arrive' ? 'straight' : st.type, fmtDist(d), d > 1500 && st.type !== 'arrive' ? `道なり（その先 ${word}）` : label);
  if (st.type !== 'arrive') {
    const fast = (pos.speed || 0) > 14;
    const far = fast ? 600 : 300, near = fast ? 180 : 80;
    const k1 = si + ':far', k2 = si + ':near';
    if (d < near && !nav.ann.has(k2)) { nav.ann.add(k2); nav.ann.add(k1); speak(`まもなく、${word}です${st.name ? '。' + st.name : ''}`); }
    else if (d < far && d > near + 40 && !nav.ann.has(k1)) { nav.ann.add(k1); speak(`${speakDist(d)}先、${word}です${st.name ? '。' + st.name + 'に入ります' : ''}`); }
  }
  // 注意地点
  (nav.hz || []).forEach((z) => {
    const ahead = z.along - along;
    if (ahead > 0 && ahead < 250 && !nav.hzAnn.has(z.h.id)) {
      nav.hzAnn.add(z.h.id);
      const t = HAZARD_TYPES[z.h.type] || HAZARD_TYPES.other;
      setTimeout(() => speak(`この先、${t.name}です${z.h.memo ? '。' + z.h.memo : ''}`), 1800);
      toast(`${t.icon} この先 ${t.name}${z.h.memo ? '：' + z.h.memo : ''}`, 5000);
    }
  });
}
function setBanner(type, dist, text) {
  $('nbArrowPath').setAttribute('d', ARROWS[type] || ARROWS.straight);
  $('nbDist').textContent = dist; $('nbText').textContent = text;
}
async function navDone(status) {
  const nav = S.nav, p = plan(); if (!nav) return;
  const s = p.stops[nav.idx];
  if (s) { s.status = status; s.doneAt = Date.now(); }
  save();
  const next = nextStopIndex(p);
  if (next < 0) return finishAll();
  nav.idx = next; nav.follow = true; $('btnFollow').classList.add('hidden');
  renderStops();
  speak(`次は、${stopLabel(p.stops[next])}です${p.stops[next].kind === 'pickup' ? '。集荷です' : ''}`);
  if (nav.sim && nav.route) nav.simPos = nav.simPos || null;
  await routeToCurrent(false);
}
function finishAll() {
  const p = plan();
  const skipped = p ? p.stops.filter((s) => s.status === 'skip').length : 0;
  if (skipped) {
    speak(`残りは、あとでにした${skipped}件です`);
    p.stops.forEach((s) => { if (s.status === 'skip') s.status = 'todo'; });
    save(); S.nav.idx = nextStopIndex(p); renderStops(); routeToCurrent(false); return;
  }
  speak('すべての配達が完了しました。お疲れさまでした', true);
  toast('すべての配達が完了しました。お疲れさまでした', 5000);
  endNav();
}
/* デモ走行：GPSなしでルートに沿って動く */
function startSim() {
  const nav = S.nav;
  nav.simTimer = setInterval(() => {
    if (!S.nav || !nav.route) return;
    const r = nav.route;
    nav.simAlong = (nav.simRouteRef === r ? nav.simAlong : 0) + 14; nav.simRouteRef = r;
    const a = Math.min(nav.simAlong, r.distance);
    let i = 0; while (i < r.cum.length - 2 && r.cum[i + 1] < a) i++;
    const span = r.cum[i + 1] - r.cum[i], u = span > 0 ? (a - r.cum[i]) / span : 0;
    const lat = r.coords[i][0] + u * (r.coords[i + 1][0] - r.coords[i][0]), lng = r.coords[i][1] + u * (r.coords[i + 1][1] - r.coords[i][1]);
    nav.simPos = { lat, lng, acc: 5, speed: 14, t: Date.now(), sim: true };
    onPosition(nav.simPos);
  }, 1000);
}

/* ---------- 設定・オフライン準備 ---------- */
function tilesFor(area, z) {
  const lng2x = (lng) => Math.floor((lng + 180) / 360 * (1 << z));
  const lat2y = (lat) => { const r = lat * Math.PI / 180; return Math.floor((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * (1 << z)); };
  return { x0: lng2x(area.w), x1: lng2x(area.e), y0: lat2y(area.n), y1: lat2y(area.s) };
}
function countTiles(area, maxZ) {
  let n = 0;
  for (let z = 8; z <= maxZ; z++) { const t = tilesFor(area, z); n += (t.x1 - t.x0 + 1) * (t.y1 - t.y0 + 1); }
  return n;
}
let dl = null;
async function downloadTiles() {
  if (dl) { dl.stop = true; return; }
  if (!navigator.onLine) return toast('インターネットにつないでから行ってください');
  try { if (navigator.storage && navigator.storage.persist) await navigator.storage.persist(); } catch (e) { /* なし */ }
  const src = S.settings.mapSource, area = S.settings.area, maxZ = S.settings.maxZoom;
  dl = { stop: false, done: 0, total: 0, fail: 0 };
  $('dlTiles').textContent = '中断する';
  const queue = [];
  for (let z = 8; z <= maxZ; z++) {
    const t = tilesFor(area, z);
    const have = new Set(await DB.keys('tiles', DB.prefix(`${src}/${z}/`)));
    for (let x = t.x0; x <= t.x1; x++) for (let y = t.y0; y <= t.y1; y++) { dl.total++; const k = tileKey(src, z, x, y); if (have.has(k)) dl.done++; else queue.push([z, x, y]); }
  }
  const batch = [];
  const flush = async () => { if (batch.length) { const b = batch.splice(0); await DB.putMany('tiles', b); } };
  const show = () => { $('dlBar').style.width = (dl.done / dl.total * 100) + '%'; $('dlMsg').textContent = `${dl.done} / ${dl.total} 枚${dl.fail ? `（失敗 ${dl.fail}）` : ''}`; };
  show();
  let qi = 0;
  const workerFn = async () => {
    while (qi < queue.length && !dl.stop) {
      const [z, x, y] = queue[qi++];
      try {
        const r = await fetchTimeout(tileUrl(src, z, x, y), 15000);
        if (r.ok) { batch.push([tileKey(src, z, x, y), await r.blob()]); if (batch.length >= 25) await flush(); }
        else if (r.status !== 404) dl.fail++;
      } catch (e) { dl.fail++; }
      dl.done++; if (dl.done % 10 === 0) show();
    }
  };
  await Promise.all([0, 1, 2, 3, 4].map(workerFn));
  await flush(); show();
  const stopped = dl.stop; dl = null;
  $('dlTiles').textContent = '地図をダウンロード';
  toast(stopped ? 'ダウンロードを中断しました（続きから再開できます）' : '地図のダウンロードが終わりました', 4000);
  renderSettings();
}
async function buildRoads() {
  if (!navigator.onLine) return toast('インターネットにつないでから行ってください');
  if (S.graphMeta && !(await ask('道路データを作り直しますか？（数分〜20分ほどかかることがあります）', '作り直す'))) return;
  try { if (navigator.storage && navigator.storage.persist) await navigator.storage.persist(); } catch (e) { /* なし */ }
  $('rdBuild').disabled = true; $('rdProg').classList.remove('hidden');
  keepAwake();
  try {
    S.graphMeta = await call('build', { bbox: Object.assign({ rows: Math.max(1, Math.ceil((S.settings.area.n - S.settings.area.s) / 0.14)), cols: Math.max(1, Math.ceil((S.settings.area.e - S.settings.area.w) / 0.15)) }, S.settings.area) }, (pr) => {
      if (pr.total) $('rdBar').style.width = (pr.done / pr.total * 100) + '%';
      $('rdMsg').textContent = pr.msg || '';
    });
    toast('道路データができました。オフラインでもルート案内できます', 5000);
  } catch (e) {
    toast('道路データを作れませんでした：' + e.message, 6000);
  }
  try { if (wakeLock && !S.nav) { wakeLock.release(); wakeLock = null; } } catch (e) { /* なし */ }
  renderSettings();
}
async function renderSettings() {
  const st = S.settings, a = st.area;
  const nz = (z) => countTiles(a, z), zopt = (z, label) => `<option value="${z}" ${st.maxZoom === z ? 'selected' : ''}>${label}（約${nz(z).toLocaleString()}枚・約${Math.round(nz(z) * 0.018)}MB）</option>`;
  let tileCount = '…', usage = '';
  const el = $('pane-settings');
  el.innerHTML = `
    <h3>地図の種類</h3>
    <select id="stSrc">${Object.entries(MAP_SOURCES).map(([k, v]) => `<option value="${k}" ${k === st.mapSource ? 'selected' : ''}>${esc(v.name)}</option>`).join('')}<option disabled>ゼンリン地図（契約後に追加）</option></select>
    <h3>オフライン準備</h3>
    <p class="small muted">家のWi-Fiなど、つながる所で一度行えば、電波がなくても地図とルート案内が使えます。</p>
    <div class="status-line">範囲：<b id="stArea">${esc(a.name || '指定した範囲')}</b></div>
    <div class="btngrid"><button id="stAreaShinko">信更町とその周辺</button><button id="stAreaPreset">長野市とその周辺</button><button id="stAreaView" style="grid-column:1/-1">今見ている範囲にする</button></div>
    <label>地図の細かさ（どこまで拡大して見られるか）</label>
    <select id="stZoom">${zopt(15, 'ふつう')}${zopt(16, '細かい')}${zopt(17, 'とても細かい（家の形まで）')}</select>
    <div class="status-line" style="margin-top:10px">① 地図：保存済み <b id="stTiles">${tileCount}</b> 枚</div>
    <button id="dlTiles" class="primary" style="width:100%">地図をダウンロード</button>
    <div class="progress"><div id="dlBar"></div></div><div id="dlMsg" class="small muted"></div>
    <div class="status-line" style="margin-top:10px">② 道路データ（ルート計算用）：<b>${S.graphMeta ? new Date(S.graphMeta.created).toLocaleDateString('ja-JP') + ' 作成（' + S.graphMeta.nSeg.toLocaleString() + '区間）' : 'まだありません'}</b></div>
    <button id="rdBuild" class="primary" style="width:100%">${S.graphMeta ? '道路データを作り直す' : '道路データを作る'}</button>
    <div class="progress hidden" id="rdProg"><div id="rdBar"></div></div><div id="rdMsg" class="small muted"></div>
    <div class="status-line" id="stUsage"></div>
    <label style="display:flex;gap:10px;align-items:center;color:var(--text)"><input type="checkbox" id="stAuto" style="width:24px;height:24px" ${st.autoCache ? 'checked' : ''}> 見た地図も自動で保存する</label>
    <h3>音声案内</h3>
    <div class="row"><button id="stVoice">${st.speech ? '🔊 音声あり' : '🔇 音声なし'}</button><button id="stVoiceTest">試しに話す</button></div>
    <h3>音声入力</h3>
    <p class="small muted">入力欄の横に🎤ボタンを出します。押して話すと文字になります。</p>
    <button id="stMic" style="width:100%">${st.voiceInput ? '🎤 音声入力ボタン：表示する' : '音声入力ボタン：表示しない'}</button>
    <h3>よく使う住所（${S.favorites.length}件）</h3>
    <button id="stFav" style="width:100%">よく使う住所を編集する</button>
    <h3>注意地点（${S.hazards.length}件）</h3>
    <p class="small muted">凍結しやすい所やチェーンを着けた所を登録すると、ナビ中に近づいたら知らせます。地図の長押しでも追加できます。</p>
    <button id="stHz" style="width:100%">地図をタップして追加</button>
    <h3>動作確認</h3>
    <button id="stDemo" style="width:100%">デモ走行（GPSなしでナビを試す）</button>
    <h3>データの控え</h3>
    <div class="row"><button id="stExport">控えを作る</button><button id="stImport">控えから戻す</button></div>
    <h3>この地図について</h3>
    <p class="small muted">地図：国土地理院。道路データ：© OpenStreetMap contributors（ODbL）。住所データ：Geolonia 住所データ（CC BY 4.0、国土交通省 位置参照情報をもとに作成）。地図表示：Leaflet。<br>道路データは実際の通行規制と違うことがあります。必ず実際の道路標識に従ってください。</p>`;
  $('stSrc').onchange = (e) => { st.mapSource = e.target.value; save(); setBaseLayer(); renderSettings(); };
  $('stAreaView').onclick = () => { const b = map.getBounds(); st.area = { name: '指定した範囲', s: +b.getSouth().toFixed(4), w: +b.getWest().toFixed(4), n: +b.getNorth().toFixed(4), e: +b.getEast().toFixed(4) }; save(); renderSettings(); toast('範囲を変えました。道路データも作り直してください'); };
  $('stAreaPreset').onclick = () => { st.area = Object.assign({}, PRESET_AREAS.nagano); save(); renderSettings(); toast('範囲を変えました。道路データも作り直してください'); };
  $('stAreaShinko').onclick = () => { st.area = Object.assign({}, PRESET_AREAS.shinko); save(); renderSettings(); toast('範囲を変えました。道路データも作り直してください'); };
  $('stMic').onclick = () => { st.voiceInput = !st.voiceInput; save(); renderSettings(); };
  $('stFav').onclick = favManager;
  $('stZoom').onchange = (e) => { st.maxZoom = +e.target.value; save(); };
  $('dlTiles').onclick = downloadTiles;
  if (dl) $('dlTiles').textContent = '中断する';
  $('rdBuild').onclick = buildRoads;
  $('stAuto').onchange = (e) => { st.autoCache = e.target.checked; save(); };
  $('stVoice').onclick = () => { st.speech = !st.speech; save(); renderSettings(); };
  $('stVoiceTest').onclick = () => speak('300メートル先、右折です', true);
  $('stHz').onclick = () => startPick('注意地点をタップしてください', hazardDialog);
  $('stDemo').onclick = () => { const p = plan(); if (!p || nextStopIndex(p) < 0) return toast('先に配達先を登録してください'); startNav(true); };
  $('stExport').onclick = exportDialog;
  $('stImport').onclick = importDialog;
  DB.count('tiles', DB.prefix(st.mapSource + '/')).then((c) => { const t = $('stTiles'); if (t) t.textContent = c.toLocaleString(); });
  if (navigator.storage && navigator.storage.estimate) navigator.storage.estimate().then((e) => { const u = $('stUsage'); if (u) u.innerHTML = `端末の使用量：<b>${Math.round(e.usage / 1048576)}MB</b>（使える目安 ${Math.round(e.quota / 1048576).toLocaleString()}MB）`; });
}
function exportDialog() {
  const txt = JSON.stringify({ app: 'haitatsu-navi', v: 1, plans: S.plans, hazards: S.hazards, favorites: S.favorites, settings: S.settings });
  openModal(`<h2>データの控え</h2><p class="small muted">下の文字をコピーして、メモアプリなどに貼り付けて保存してください。</p><textarea id="exTxt" readonly>${esc(txt)}</textarea>
    <div class="modal-btns"><button id="exNo">閉じる</button><button id="exCopy" class="primary">コピー</button></div>`, () => {
    $('exNo').onclick = closeModal;
    $('exCopy').onclick = async () => { try { await navigator.clipboard.writeText(txt); toast('コピーしました'); } catch (e) { $('exTxt').select(); toast('文字を長押ししてコピーしてください'); } };
  });
}
function importDialog() {
  openModal(`<h2>控えから戻す</h2><p class="small muted">保存しておいた控えの文字を貼り付けてください。今のプラン・注意地点・よく使う住所は置き換わります。</p><textarea id="imTxt"></textarea>
    <div class="modal-btns"><button id="imNo">やめる</button><button id="imOk" class="primary">戻す</button></div>`, () => {
    $('imNo').onclick = closeModal;
    $('imOk').onclick = () => {
      try {
        const d = JSON.parse($('imTxt').value);
        if (d.app !== 'haitatsu-navi') throw new Error('形式が違います');
        S.plans = d.plans || []; S.hazards = d.hazards || []; S.favorites = d.favorites || []; if (d.settings) Object.assign(S.settings, d.settings);
        S.planId = S.plans[0] ? S.plans[0].id : null; save(); closeModal(); renderAll(); toast('戻しました');
      } catch (e) { toast('戻せませんでした：' + e.message); }
    };
  });
}

/* ---------- タブ ---------- */
function showTab(name) {
  document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  ['plan', 'add', 'settings'].forEach((t) => $('pane-' + t).classList.toggle('hidden', t !== name));
  $('sheet').classList.remove('collapsed');
  if (name === 'plan') renderPlan();
  if (name === 'add') { renderAdd(); }
  if (name === 'settings') renderSettings();
}
function renderAll() { renderPlan(); renderStops(); renderHazards(); setBaseLayer(); }

function layersDialog() {
  openModal(`<h2>地図の種類</h2>${Object.entries(MAP_SOURCES).map(([k, v]) => `<button data-src="${k}" class="${k === S.settings.mapSource ? 'primary' : ''}" style="width:100%;margin:4px 0">${esc(v.name)}</button>`).join('')}
    <button disabled style="width:100%;margin:4px 0">ゼンリン地図（契約後に追加）</button><p class="small muted">オフラインで使えるのは、ダウンロードした種類の地図です。</p>
    <div class="modal-btns"><button id="lyNo">閉じる</button></div>`, (box) => {
    $('lyNo').onclick = closeModal;
    box.querySelectorAll('[data-src]').forEach((b) => { b.onclick = () => { S.settings.mapSource = b.dataset.src; save(); setBaseLayer(); closeModal(); }; });
  });
}

/* ---------- 起動 ---------- */
async function boot() {
  initMap();
  updateNet();
  try {
    const st = await DB.get('kv', 'state');
    if (st) { Object.assign(S.settings, st.settings || {}); S.plans = st.plans || []; S.planId = st.planId; S.hazards = st.hazards || []; S.favorites = st.favorites || [];
      if (!st.settings || !st.settings.v) { S.settings.v = 2; S.settings.area = Object.assign({}, PRESET_AREAS.shinko); S.settings.maxZoom = 17; if (S.settings.voiceInput === undefined) S.settings.voiceInput = true; } }
  } catch (e) { toast('この端末ではデータを保存できないようです'); }
  if (!plan() && S.plans[0]) S.planId = S.plans[0].id;
  setBaseLayer();
  await loadAddr();
  renderPlan(); renderStops(); renderHazards();
  const p = plan();
  if (p && p.stops.length) map.fitBounds(L.latLngBounds(p.stops.map((s) => [s.lat, s.lng])), { padding: [30, 30], maxZoom: 16 });
  call('load').then((m) => { S.graphMeta = m; if (!$('pane-settings').classList.contains('hidden')) renderSettings(); }).catch(() => {});

  document.querySelectorAll('.tabs button').forEach((b) => { b.onclick = () => showTab(b.dataset.tab); });
  $('sheetHandle').onclick = () => $('sheet').classList.toggle('collapsed');
  $('btnLocate').onclick = () => { S.locateOnce = true; startGeo(); if (S.pos) onPosition(S.pos); };
  $('btnLayers').onclick = layersDialog;
  $('pickCancel').onclick = endPick;
  $('btnFollow').onclick = () => { if (!S.nav) return; S.nav.follow = true; $('btnFollow').classList.add('hidden'); updateNav(); };
  $('nvDone').onclick = () => navDone('done');
  $('nvSkip').onclick = () => navDone('skip');
  $('nvEnd').onclick = async () => { if (await ask('ナビを終了しますか？', '終了する')) endNav(); };
  $('nvVoice').onclick = () => { S.settings.speech = !S.settings.speech; save(); $('nvVoice').textContent = S.settings.speech ? '🔊' : '🔇'; if (S.settings.speech) speak('音声案内をオンにしました'); };
  $('nvExt').onclick = () => {
    const p2 = plan(), s = S.nav && p2.stops[S.nav.idx]; if (!s) return;
    if (!navigator.onLine) return toast('外部ナビはインターネット接続が必要です');
    openExternal(`https://www.google.com/maps/dir/?api=1&destination=${s.lat},${s.lng}&travelmode=driving`);
  };
  $('modal').onclick = (e) => { if (e.target === $('modal')) closeModal(); };

  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
  if (DEMO) window.__S = S;
}
boot();
