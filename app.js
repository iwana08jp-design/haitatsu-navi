/* 配達ナビ — 画面の動き */
'use strict';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const GC = window.GraphCore;
const DEMO = /[?&]demo/.test(location.search);
const APP_VERSION = '第26版（2026年11月28日）';
const STATUS = { todo: '未配達', done: '配達完了', absent: '不在', redeliver: '再配達', skip: 'あとで' };
const isOpen = (s) => s.status !== 'done';
const ROUTE_MODES = [
  { k: 'best', label: '最適ルート', desc: '時間指定は気にせず、全体で一番早く回れる順番' },
  { k: 'slot', label: '時間指定を優先', desc: '午前中 → 14〜16時 → 16〜18時 → 19〜21時の順に、その中で早い順番' },
  { k: 'near', label: '近い順', desc: '出発地から近い所を先に、次々と一番近い所へ' },
  { k: 'far', label: '遠い順', desc: '一番遠い所へ先に行き、戻りながら近い所へ' }
];

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
  settings: { v: 3, mapSource: 'gsi_pale', area: Object.assign({}, PRESET_AREAS.shinko), maxZoom: 17, photoZoom: 17, speech: true, voiceInput: true, lastTown: '',
    startMode: 'gps', home: null, endMode: 'open', autoCache: true },
  plans: [], planId: null, hazards: [], favorites: [], drawings: [],
  graphMeta: null, pos: null, nav: null, expanded: null, pick: null
};
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const plan = () => S.plans.find((p) => p.id === S.planId);

let saveTimer = null;
function save() {
  calibCache = null;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    DB.put('kv', 'state', { settings: S.settings, plans: S.plans, planId: S.planId, hazards: S.hazards, favorites: S.favorites, drawings: S.drawings }).catch((e) => toast('保存できませんでした：' + e.message));
    autoSnapshot();
    if (typeof renderFavs === 'function') renderFavs();
  }, 300);
}
/* ---------- 毎日の控え（端末の中に自動で14日分） ---------- */
const SNAP_DAYS = 14;
function dayStr(d) { d = d || new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }
function backupData() { return { app: 'haitatsu-navi', v: 1, at: new Date().toISOString(), plans: S.plans, hazards: S.hazards, favorites: S.favorites, drawings: S.drawings, settings: S.settings }; }
let snapPruned = false;
async function autoSnapshot() {
  if (!S.favorites.length && !S.plans.some((p) => p.stops.length)) return; // 空のときは控えを作らない
  try {
    await DB.put('kv', 'snap/' + dayStr(), backupData());
    if (!snapPruned) { snapPruned = true; const ks = (await DB.keys('kv', DB.prefix('snap/'))).sort(); for (const k of ks.slice(0, Math.max(0, ks.length - SNAP_DAYS))) await DB.del('kv', k); }
  } catch (e) { /* 控えが作れなくても本体の保存は続ける */ }
}
function applyBackup(d, msg) {
  if (!d || d.app !== 'haitatsu-navi') throw new Error('形式が違います');
  const prev = JSON.parse(JSON.stringify(backupData()));
  if (msg) setTimeout(() => undoToast(msg, () => applyBackup(prev)), 50);
  S.plans = d.plans || []; S.hazards = d.hazards || []; S.favorites = d.favorites || []; S.drawings = d.drawings || []; if (d.settings) Object.assign(S.settings, d.settings);
  S.planId = S.plans[0] ? S.plans[0].id : null; save(); renderAll();
}
async function snapshotsDialog() {
  const ks = (await DB.keys('kv', DB.prefix('snap/'))).sort().reverse();
  const rows = [];
  for (const k of ks) { const d = await DB.get('kv', k); rows.push({ k, day: k.slice(5), fav: (d.favorites || []).length, stops: (d.plans || []).reduce((a, p) => a + p.stops.length, 0), at: d.at }); }
  openModal(`<h2>毎日の控え（自動）</h2><p class="small muted">その日の最後の状態を、端末の中に${SNAP_DAYS}日分とってあります。間違えて消したときは、戻したい日を押してください。</p>
    ${rows.length ? rows.map((r) => `<div class="snap-row"><div><b>${r.day.replace(/^(\d+)-(\d+)-(\d+)$/, (m, y, mo, d) => `${+mo}月${+d}日`)}</b>${r.k === 'snap/' + dayStr() ? '（今日）' : ''}<div class="small muted">よく配達する家 ${r.fav}軒・配達先 ${r.stops}件</div></div><button data-snap="${r.k}">この日に戻す</button></div>`).join('') : '<p class="muted">まだ控えがありません。家を登録すると、自動で作られます。</p>'}
    <div class="modal-btns"><button id="snNo">閉じる</button></div>`, (box) => {
    $('snNo').onclick = closeModal;
    box.querySelectorAll('[data-snap]').forEach((b) => {
      b.onclick = async () => {
        if (!(await ask(`${b.closest('.snap-row').querySelector('b').textContent}の状態に戻しますか？今の内容は置き換わります。`, '戻す', true))) return;
        try { closeModal(); applyBackup(await DB.get('kv', b.dataset.snap), '控えの日の状態に戻しました'); } catch (e) { toast('戻せませんでした：' + e.message); }
      };
    });
  });
}
/* ---------- 控えをファイルに保存（iCloud Drive など） ---------- */
async function saveBackupFile() {
  const name = `haitatsu-navi-${dayStr()}.json`;
  const blob = new Blob([JSON.stringify(backupData())], { type: 'application/json' });
  const file = new File([blob], name, { type: 'application/json' });
  try {
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file], title: '配達ナビの控え' });
      S.settings.lastFileBackup = dayStr(); save(); return true;
    }
  } catch (e) { if (e && e.name === 'AbortError') return false; }
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  S.settings.lastFileBackup = dayStr(); save(); return true;
}
function restoreFileDialog() {
  const inp = document.createElement('input'); inp.type = 'file'; inp.accept = '.json,application/json';
  inp.onchange = async () => {
    const f = inp.files[0]; if (!f) return;
    try {
      const d = JSON.parse(await f.text());
      const n = (d.favorites || []).length;
      if (!(await ask(`「${f.name}」から戻しますか？（よく配達する家 ${n}軒）今の内容は置き換わります。`, '戻す', true))) return;
      applyBackup(d, 'ファイルから戻しました');
    } catch (e) { toast('戻せませんでした：' + e.message); }
  };
  inp.click();
}
/* 配達が終わったら、その日1回だけ「ファイルに保存」をすすめる */
function offerDailyFileBackup() {
  if (S.settings.dailyFileBackup === false || S.settings.lastFileBackup === dayStr() || !S.favorites.length) return;
  openModal(`<h2>今日の控えを保存しますか？</h2><p>お疲れさまでした。控えをファイルにしておくと、iPhoneを替えたときやデータが消えたときに戻せます。</p>
    <p class="small muted">次の画面で「<b>"ファイル"に保存</b>」→「<b>iCloud Drive</b>」を選んでください。同じ名前のファイルは上書きしてかまいません。</p>
    <div class="modal-btns"><button id="dfNo">今日はしない</button><button id="dfOk" class="primary">保存する</button></div>`, () => {
    $('dfNo').onclick = () => { S.settings.lastFileBackup = dayStr(); save(); closeModal(); };
    $('dfOk').onclick = async () => { const ok = await saveBackupFile(); closeModal(); if (ok) toast('控えを保存しました'); };
  });
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
let undoTimer;
function undoToast(msg, onUndo) {
  let bar = $('undoBar');
  if (!bar) { bar = document.createElement('div'); bar.id = 'undoBar'; document.body.appendChild(bar); }
  bar.innerHTML = `<span>${esc(msg)}</span><button>元に戻す</button>`;
  bar.classList.remove('hidden');
  bar.querySelector('button').onclick = () => { bar.classList.add('hidden'); onUndo(); };
  clearTimeout(undoTimer); undoTimer = setTimeout(() => bar.classList.add('hidden'), 8000);
}
function openModal(html, onReady) {
  $('modal').classList.remove('mini');
  $('modalBox').innerHTML = `<div class="modal-handle" id="mHandle"><span></span><em>▼ 下げて地図を見る</em></div>` + html; $('modal').classList.remove('hidden');
  const h = $('mHandle');
  h.onclick = () => { const mini = $('modal').classList.toggle('mini'); h.querySelector('em').textContent = mini ? '▲ 入力に戻る' : '▼ 下げて地図を見る'; if (mini) { $('modalBox').scrollTop = 0; $('sheet').classList.add('collapsed'); } };
  swipe(h, () => { if (!$('modal').classList.contains('mini')) h.onclick(); }, () => { if ($('modal').classList.contains('mini')) h.onclick(); });
  if (onReady) onReady($('modalBox'));
}
function closeModal() { $('modal').classList.add('hidden'); $('modal').classList.remove('mini'); $('modalBox').innerHTML = ''; }
/* 上下に指でなぞったとき */
function swipe(el, onDown, onUp) {
  let y0 = null;
  el.addEventListener('touchstart', (e) => { y0 = e.touches[0].clientY; }, { passive: true });
  el.addEventListener('touchend', (e) => {
    if (y0 == null) return; const dy = e.changedTouches[0].clientY - y0; y0 = null;
    if (dy > 40) { onDown(); e.preventDefault(); } else if (dy < -40) { onUp(); e.preventDefault(); }
  });
}
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
let map, baseLayer, meMarker, stopLayer, hazardLayer, favLayer, routeLine, orderLine;
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
const BASE_MAP = 'gsi_pale', PHOTO_MAP = 'gsi_photo';
function updatePhotoButtons(src) {
  const photo = src === PHOTO_MAP;
  ['btnPhoto', 'nvPhoto'].forEach((id) => { const b = $(id); if (b) { b.textContent = photo ? '🗺 地図' : '📷 写真'; b.classList.toggle('on', photo); } });
}
function togglePhoto() {
  S.settings.mapSource = S.settings.mapSource === PHOTO_MAP ? BASE_MAP : PHOTO_MAP;
  save(); setBaseLayer();
  if ($('pane-settings') && !$('pane-settings').classList.contains('hidden')) renderSettings();
}
function setBaseLayer() {
  if (baseLayer) map.removeLayer(baseLayer);
  const src = MAP_SOURCES[S.settings.mapSource] ? S.settings.mapSource : 'gsi_pale';
  updatePhotoButtons(src);
  baseLayer = new OfflineLayer({ src, maxZoom: 19, attribution: MAP_SOURCES[src].attr + ' | 道路 © <a href="https://www.openstreetmap.org/copyright" target="_blank">OpenStreetMap</a>', keepBuffer: 3 });
  baseLayer.addTo(map);
}

function initMap() {
  map = L.map('map', { zoomControl: false, maxZoom: 19, minZoom: 6, rotate: true, bearing: 0, touchRotate: false, rotateControl: false, shiftKeyRotate: false, touchPitch: false, pitchDrag: false }).setView([36.6486, 138.1948], 13);
  setBaseLayer();
  map.createPane('favPane', map.getPane('norotatePane') || undefined); map.getPane('favPane').style.zIndex = 590;
  favLayer = L.layerGroup().addTo(map);
  stopLayer = L.layerGroup().addTo(map);
  hazardLayer = L.layerGroup().addTo(map);
  const zcls = () => map.getContainer().classList.toggle('zoom-lo', map.getZoom() < 16);
  map.on('zoomend', zcls); zcls();
  map.on('rotate', () => { updateCompass(); updateMeArrow(); });
  setupOrient();
  setupDrawing();
  map.on('click', onMapClick);
  map.on('contextmenu', (e) => mapMenu(e.latlng));
  map.on('dragstart', () => { if (S.settings.follow !== 'manual') { setFollow('manual', true); toast('手動にしました（🚗を押すと自動に戻ります）', 2500); } });
}
function onMapClick(e) {
  if (S.pick) { const cb = S.pick.cb; endPick(); cb(e.latlng); return; }
  if (DR.on || ($('placeUI') && !$('placeUI').classList.contains('hidden'))) return;
  if (!$('modal').classList.contains('hidden') && !$('modal').classList.contains('mini')) return;
  mapMenu(e.latlng);
}
function startPick(text, cb) {
  S.pick = { cb }; $('pickText').textContent = text; $('pickBar').classList.remove('hidden');
  $('sheet').classList.add('collapsed');
}
function endPick() { S.pick = null; $('pickBar').classList.add('hidden'); }
function mapMenu(ll) {
  if (DR.on) return;
  const div = document.createElement('div');
  div.innerHTML = `<div class="small muted">${esc(nearLabel(ll.lat, ll.lng))}</div>
    <button class="primary" data-a="stop">配達先に追加</button><button data-a="hz">注意地点に追加</button>${S.nav ? '' : '<button data-a="home">ここを出発地にする</button>'}`;
  const pop = L.popup().setLatLng(ll).setContent(div).openOn(map);
  div.querySelector('[data-a=stop]').onclick = () => { map.closePopup(pop); newStopDialog({ lat: ll.lat, lng: ll.lng, address: nearLabel(ll.lat, ll.lng) }); };
  div.querySelector('[data-a=hz]').onclick = () => { map.closePopup(pop); hazardDialog(ll); };
  if (div.querySelector('[data-a=home]')) div.querySelector('[data-a=home]').onclick = () => { map.closePopup(pop); S.settings.home = { lat: ll.lat, lng: ll.lng, label: nearLabel(ll.lat, ll.lng) }; S.settings.startMode = 'home'; save(); renderPlan(); toast('出発地を設定しました'); };
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
    return js.slice(0, 8).map((f) => ({ label: f.properties.title, lat: f.geometry.coordinates[1], lng: f.geometry.coordinates[0], approx: !/[0-9０-９]/.test(f.properties.title), src: 'on' }));
  } catch (e) { return []; }
}
function nearLabel(lat, lng) {
  let best = null, bd = Infinity;
  for (const a of ADDR) { const d = GC.hav(lat, lng, a.lat, a.lng); if (d < bd) { bd = d; best = a; } }
  return best && bd < 4000 ? best.city + best.town : `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
}
async function geocode(q) {
  const on = await onlineSearch(q);
  if (on.length) return on[0];
  const off = offlineSearch(q);
  return off[0] || null;
}

/* ---------- 地図の向き（北が上／進む方向が上／自由に回す） ---------- */
const ORIENTS = { north: '北が上', heading: '進行方向', free: '自由' };
const OR = { heading: null, compass: null, lastPos: null, compassOn: false };
function distM(a, b) { const R = 6371000, r = Math.PI / 180, dLat = (b.lat - a.lat) * r, dLng = (b.lng - a.lng) * r * Math.cos((a.lat + b.lat) / 2 * r); return R * Math.hypot(dLat, dLng); }
function bearingDeg(a, b) { const r = Math.PI / 180, y = Math.sin((b.lng - a.lng) * r) * Math.cos(b.lat * r), x = Math.cos(a.lat * r) * Math.sin(b.lat * r) - Math.sin(a.lat * r) * Math.cos(b.lat * r) * Math.cos((b.lng - a.lng) * r); return (Math.atan2(y, x) / r + 360) % 360; }
// 画面の上から時計回りに、その方角（真北から何度）が何度に見えるか
function screenAngleOf(deg) {
  const c = map.getCenter(), r = Math.PI / 180, d = 0.001;
  const q = L.latLng(c.lat + d * Math.cos(deg * r), c.lng + d * Math.sin(deg * r) / Math.cos(c.lat * r));
  const a = map.latLngToContainerPoint(c), b = map.latLngToContainerPoint(q);
  return (Math.atan2(b.x - a.x, a.y - b.y) / r + 360) % 360;
}
function updateCompass() {
  const rose = $('cpRose'); if (!rose || !map) return;
  rose.style.transform = `rotate(${screenAngleOf(0)}deg)`;
}
function updateMeArrow() {
  if (!meMarker) return;
  const el = meMarker.getElement(); if (!el) return;
  const tri = el.querySelector('.me-tri'); if (!tri) return;
  tri.classList.toggle('nohead', OR.heading == null);
  tri.style.transform = `rotate(${screenAngleOf(OR.heading == null ? 0 : OR.heading)}deg)`;
}
function applyHeadingUp() {
  if (!map.setBearing || OR.heading == null) return;
  // 進む方向が画面の上になる向きに回す（符号は実際の見え方から決める）
  const cur = map.getBearing(), seen = screenAngleOf(OR.heading);
  let target = cur - seen * OR.sign;
  target = ((target % 360) + 360) % 360;
  let diff = ((target - cur + 540) % 360) - 180;
  if (Math.abs(diff) < 3) return;
  map.setBearing(cur + diff);
}
function setOrient(mode, quiet) {
  S.settings.orient = mode; save();
  if (map.touchRotate) { mode === 'free' ? map.touchRotate.enable() : map.touchRotate.disable(); }
  if (mode === 'north' && map.setBearing) map.setBearing(0);
  if (mode === 'heading') { startCompass(); if (OR.heading != null) applyHeadingUp(); else if (!quiet) toast('動き出すと、進む方向が上になります', 2500); }
  $('cpLabel').textContent = ORIENTS[mode];
  $('btnCompass').className = 'or-' + mode;
  if (!quiet) toast(mode === 'north' ? '北が上になりました' : mode === 'heading' ? '進む方向が上になります' : '2本の指で地図を回せます', 2200);
  updateCompass(); updateMeArrow();
}
/* 地図が車の動きについていくか（自動）／止めておくか（手動） */
function setFollow(mode, quiet) {
  S.settings.follow = mode; save();
  const b = $('btnFollowMode'); b.className = 'fm-' + mode; $('fmLabel').textContent = mode === 'auto' ? '自動' : '手動';
  $('btnFollow').classList.toggle('hidden', mode === 'auto' || !S.nav);
  if (mode === 'auto') {
    startGeo();
    if (S.pos) map.setView([S.pos.lat, S.pos.lng], Math.max(map.getZoom(), 16), { animate: true });
    else if (!quiet) S.locateOnce = true;
    if (S.nav && !S.nav.nonav) updateNav();
  }
  if (!quiet) toast(mode === 'auto' ? '自動：車の動きに合わせて地図が動きます' : '手動：地図は止まったままです', 2200);
}
function startCompass() {
  if (OR.compassOn) return;
  const on = () => { OR.compassOn = true; window.addEventListener('deviceorientation', (e) => {
    let h = e.webkitCompassHeading; if (!Number.isFinite(h)) { if (e.absolute && Number.isFinite(e.alpha)) h = 360 - e.alpha; else return; }
    OR.compass = h;
    if (S.pos && (S.pos.speed == null || S.pos.speed < 0.8) && !(OR.lastMove && Date.now() - OR.lastMove < 4000)) {
      OR.heading = h; updateMeArrow();
      if (S.settings.orient === 'heading' && (!OR.lastTurn || Date.now() - OR.lastTurn > 300)) { OR.lastTurn = Date.now(); applyHeadingUp(); }
    }
  }, true); };
  try {
    if (window.DeviceOrientationEvent && typeof DeviceOrientationEvent.requestPermission === 'function') DeviceOrientationEvent.requestPermission().then((r) => { if (r === 'granted') on(); }).catch(() => {});
    else if (window.DeviceOrientationEvent) on();
  } catch (e) { /* コンパスが使えなくてもGPSの向きで回す */ }
}
function setupOrient() {
  // setBearing の向き（時計回り／反時計回り）を一度だけ調べる
  OR.sign = 1;
  if (map.setBearing) {
    map.setBearing(30); const seen = screenAngleOf(0); map.setBearing(0);
    OR.sign = Math.abs(((seen - 30 + 540) % 360) - 180) < 5 ? 1 : -1;
  }
  $('btnCompass').onclick = () => { const order = ['north', 'heading', 'free']; const cur = S.settings.orient || 'north'; setOrient(order[(order.indexOf(cur) + 1) % 3]); };
  setOrient(S.settings.orient === 'free' ? 'free' : 'north', true); // 開いたときは北が上（自由なら自由のまま）
  $('btnFollowMode').onclick = () => setFollow(S.settings.follow === 'manual' ? 'auto' : 'manual');
  setFollow(S.settings.follow === 'manual' ? 'manual' : 'auto', true);
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
  // 進む向き：GPSの向き → 動いた方向 → 止まっているときはコンパス
  const prev = OR.lastPos;
  if (Number.isFinite(p.heading) && p.heading >= 0 && (p.speed == null || p.speed > 0.8)) { OR.heading = p.heading; OR.lastMove = Date.now(); }
  else if (prev && distM(prev, p) > 8) { OR.heading = bearingDeg(prev, p); OR.lastMove = Date.now(); }
  else if (OR.compass != null && (p.speed == null || p.speed < 0.8)) OR.heading = OR.compass;
  if (!prev || distM(prev, p) > 8) OR.lastPos = { lat: p.lat, lng: p.lng };
  if (!meMarker) meMarker = L.marker([p.lat, p.lng], { icon: L.divIcon({ className: '', html: '<div class="me-tri"><svg viewBox="0 0 40 40"><path d="M20 3 L35 35 L20 27 L5 35 Z"/></svg></div>', iconSize: [40, 40], iconAnchor: [20, 20] }), zIndexOffset: 1000, interactive: false }).addTo(map);
  else meMarker.setLatLng([p.lat, p.lng]);
  updateMeArrow();
  if (S.settings.orient === 'heading' && OR.heading != null) applyHeadingUp();
  if (S.settings.follow !== 'manual' && !(S.nav && !S.nav.nonav) && !S.locateOnce) map.panTo([p.lat, p.lng], { animate: true, duration: 0.5 });
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
    approx: !!o.approx, priority: false, slot: o.slot || '', kind: o.kind || 'deliver', temp: o.temp || '', okihai: o.okihai || '', collect: o.collect || 0, favId: o.favId || null, posSrc: o.posSrc || '', chibanEst: !!o.chibanEst, status: 'todo' };
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
    const cls = s.status === 'todo' && i === nextIdx ? 'next' : (s.status === 'todo' ? '' : s.status);
    const faint = s.status === 'done';
    const m = L.marker([s.lat, s.lng], { draggable: !S.nav, autoPan: true, zIndexOffset: faint ? -500 : 0, icon: faint ? L.divIcon({ className: '', html: `<div class="fpin done"></div><div class="flbl">${esc(s.name || (s.address || '').replace(HOME_AREA.city + HOME_AREA.town, ''))}</div>`, iconSize: [22, 22], iconAnchor: [11, 11] }) : L.divIcon({ className: '', html: `<div class="pin ${cls} ${s.kind === 'pickup' ? 'pickup' : ''}"><span>${i + 1}</span></div>${s.slot ? `<div class="slotb">${slotOf(s.slot).short}</div>` : ''}${s.temp ? `<div class="tempb">${s.temp === 'frozen' ? '❄️' : '🧊'}</div>` : ''}`, iconSize: [32, 32], iconAnchor: [4, 34] }) });
    m.on('click', () => { if (S.nav) { if (s.status !== 'done' && S.nav.idx !== i) { S.nav.idx = i; if (s.status !== 'todo') s.status = 'todo'; save(); renderStops(); toast(`「${stopLabel(s)}」を次の配達先にしました`); routeToCurrent(false); } return; } S.expanded = s.id; showTab('plan'); renderPlan(); $('sheet').classList.remove('collapsed'); const el = document.querySelector(`[data-sid="${s.id}"]`); if (el) el.scrollIntoView({ block: 'center' }); });
    m.on('dragstart', () => { m._from = { lat: s.lat, lng: s.lng, approx: s.approx }; });
    m.on('dragend', () => {
      const ll = m.getLatLng(), from = m._from;
      s.lat = ll.lat; s.lng = ll.lng; s.approx = false; s.posSrc = 'user'; s.chibanEst = false; p.estimate = null; updateFavoriteFromStop(s); save(); renderPlan(); renderStops();
      undoToast(`${i + 1}番「${stopLabel(s)}」の位置を動かしました`, () => { Object.assign(s, from); updateFavoriteFromStop(s); save(); renderPlan(); renderStops(); toast('元の位置に戻しました'); });
    });
    m.addTo(stopLayer);
    if (s.status !== 'done') line.push([s.lat, s.lng]);
  });
  if (!S.nav && line.length > 1 && p.estimate) orderLine = L.polyline(line, { color: '#14213d', weight: 3, opacity: .6, dashArray: '6 8' }).addTo(map);
  renderFavs();
}
/* ---------- 登録してある家を地図に薄く出す（押すと内容を直せる） ---------- */
function renderFavs() {
  if (!favLayer) return;
  favLayer.clearLayers();
  if (S.settings.showFavs === false) return;
  const p = plan();
  S.favorites.forEach((f) => {
    if (f.lat == null) return;
    if (p && p.stops.some((s) => s.favId === f.id || (s.name === f.name && s.address === f.address))) return; // 今日の配達先は番号の印で出ている
    const m = L.marker([f.lat, f.lng], { pane: 'favPane', draggable: !S.nav, autoPan: true, icon: L.divIcon({ className: '', html: `<div class="fpin ${f.okihai === 'ng' ? 'ng' : ''}"></div><div class="flbl">${esc(f.name || (f.address || '').replace(HOME_AREA.city + HOME_AREA.town, ''))}</div>`, iconSize: [22, 22], iconAnchor: [11, 11] }) });
    m.on('click', () => favEdit(f, 'map'));
    m.on('dragstart', () => { m._from = { lat: f.lat, lng: f.lng, posSrc: f.posSrc }; });
    m.on('dragend', () => {
      const ll = m.getLatLng(), from = m._from;
      f.lat = ll.lat; f.lng = ll.lng; f.posSrc = 'user'; save(); renderFavs();
      undoToast(`「${f.name || f.address}」の位置を動かしました`, () => { Object.assign(f, from); save(); renderFavs(); });
    });
    m.addTo(favLayer);
  });
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
  const nAbsent = p.stops.filter((s) => s.status === 'absent').length, nRe = p.stops.filter((s) => s.status === 'redeliver').length;
  const view = S.planView || 'todo';
  const startText = S.settings.startMode === 'home' && S.settings.home ? '出発地：' + S.settings.home.label : '出発地：現在地';
  el.innerHTML = `
    <div class="row"><select id="pSel">${S.plans.map((x) => `<option value="${x.id}" ${x.id === p.id ? 'selected' : ''}>${esc(x.name)}（${x.stops.length}件）</option>`).join('')}</select></div>
    <div class="summary" style="margin-top:8px">
      <div><b>${total}</b> 件　完了 ${done}　残り ${total - done}${nAbsent ? `（不在 ${nAbsent}）` : ''}${nRe ? `（再配達 ${nRe}）` : ''}</div>
      ${p.stops.some((s) => s.collect > 0) ? `<div class="small">💴 コレクト 合計 ${p.stops.reduce((a, s) => a + (s.collect || 0), 0).toLocaleString()}円（受け取り済み ${p.stops.filter((s) => s.status === 'done').reduce((a, s) => a + (s.collect || 0), 0).toLocaleString()}円）</div>` : ''}
      <div class="small">${p.estimate ? `${p.estimate.mode ? '「' + ((ROUTE_MODES.find((m) => m.k === p.estimate.mode) || {}).label || '') + '」' : ''}回る時間の目安 約${fmtDur(p.estimate.totalSec)}（${p.estimate.road ? '道路データで計算' : '直線距離で概算'}）` : '「順番を決める」で回る順番を自動で決めます'}</div>
    </div>
    <div class="btngrid">
      <button class="accent" id="pOpt" ${total - done < 2 ? 'disabled' : ''}>順番を決める</button>
      <button class="ok" id="pNav" ${total - done < 1 ? 'disabled' : ''}>配達開始</button>
      <button id="pAdd">＋ 地点を追加</button>
      <button id="pBulk">まとめて登録</button>
    </div>
    <div class="row small"><span class="muted">${esc(startText)}／終わり：${S.settings.endMode === 'return' ? '出発地に戻る' : '最後の配達先'}</span><button id="pRoute" style="flex:0 0 auto">変更</button></div>
    <div class="subtabs"><button data-pv="todo" class="${view === 'todo' ? 'on' : ''}">未配達（${total - done}）</button><button data-pv="done" class="${view === 'done' ? 'on' : ''}">配達完了（${done}）</button></div>
    <div id="stopList">${(() => {
      const vis = p.stops.filter((s) => (view === 'done') === (s.status === 'done'));
      PS.sel.forEach((id) => { if (!vis.some((s) => s.id === id)) PS.sel.delete(id); });
      if (!vis.length) return '';
      const nOn = vis.filter((s) => PS.sel.has(s.id)).length, st = nOn === vis.length ? 'on' : nOn ? 'part' : '';
      return `<div class="stop-all ${st}" id="psAll"><span class="ckb">${st === 'on' ? '✓' : st === 'part' ? '－' : ''}</span><div><b>全部選択</b><div class="small muted">${nOn ? `${nOn}件を選んでいます` : `${vis.length}件をまとめて選びます`}</div></div></div>`;
    })()}${p.stops.map((s, i) => ((view === 'done') === (s.status === 'done') ? stopRow(p, s, i) : '')).join('') || (total ? `<p class="muted">${view === 'done' ? 'まだ配達完了はありません。' : '未配達はありません。お疲れさまでした。'}</p>` : '<p class="muted">配達先がまだありません。「＋ 地点を追加」から登録してください。地図をタップしても追加できます。</p>')}
    ${PS.sel.size ? `<div id="psBar"><button id="psClear">やめる</button><button id="psGo" class="${view === 'done' ? 'accent' : 'ok'}"><b>${PS.sel.size}</b>件を${view === 'done' ? '未配達に戻す' : '配達完了にする'}</button></div>` : ''}</div>
    <h3>このプラン</h3>
    <div class="btngrid"><button id="pNew2">新しいプラン</button><button id="pRename">名前を変える</button><button id="pReset">完了を全部戻す</button><button id="pDel" class="danger">プランを削除</button></div>`;
  $('pSel').onchange = (e) => { S.planId = e.target.value; S.expanded = null; PS.sel.clear(); save(); renderPlan(); renderStops(); };
  $('pOpt').onclick = optimizePlan;
  $('pNav').onclick = chooseDeliveryMode;
  el.querySelectorAll('[data-pv]').forEach((b) => { b.onclick = () => { S.planView = b.dataset.pv; S.expanded = null; PS.sel.clear(); renderPlan(); }; });
  el.querySelectorAll('[data-ck]').forEach((c) => { c.onclick = (ev) => { ev.stopPropagation(); const id = c.dataset.ck; PS.sel.has(id) ? PS.sel.delete(id) : PS.sel.add(id); renderPlanKeep(); }; });
  if ($('psAll')) $('psAll').onclick = () => {
    const vis = p.stops.filter((s) => (view === 'done') === (s.status === 'done'));
    const allOn = vis.every((s) => PS.sel.has(s.id));
    vis.forEach((s) => (allOn ? PS.sel.delete(s.id) : PS.sel.add(s.id)));
    renderPlanKeep();
  };
  if ($('psClear')) $('psClear').onclick = () => { PS.sel.clear(); renderPlanKeep(); };
  if ($('psGo')) $('psGo').onclick = () => {
    const targets = p.stops.filter((s) => PS.sel.has(s.id));
    const before = targets.map((s) => ({ s, status: s.status, doneAt: s.doneAt, lastResult: s.lastResult, logLen: (s.log || []).length }));
    const to = view === 'done' ? 'todo' : 'done';
    targets.forEach((s) => setStatus(s, to));
    PS.sel.clear(); renderPlanKeep(); renderStops();
    undoToast(`${targets.length}件を${to === 'done' ? '配達完了' : '未配達'}にしました`, () => {
      before.forEach((b) => { b.s.status = b.status; b.s.doneAt = b.doneAt; b.s.lastResult = b.lastResult; if (b.s.log) b.s.log.length = b.logLen; });
      save(); renderPlanKeep(); renderStops();
    });
  };
  $('pAdd').onclick = () => showTab('add');
  $('pBulk').onclick = bulkDialog;
  $('pRoute').onclick = routeSettingsDialog;
  $('pNew2').onclick = () => { newPlan(); renderPlan(); renderStops(); };
  $('pRename').onclick = () => openModal(`<h2>プランの名前</h2><input id="rnName" value="${esc(p.name)}"><div class="modal-btns"><button id="rnNo">やめる</button><button id="rnOk" class="primary">決定</button></div>`, () => {
    $('rnNo').onclick = closeModal; $('rnOk').onclick = () => { p.name = $('rnName').value.trim() || p.name; save(); closeModal(); renderPlan(); };
  });
  $('pReset').onclick = async () => { if (await ask('このプランの配達完了・不在・再配達の印を全部「未配達」に戻しますか？', '戻す')) { p.stops.forEach((s) => { s.status = 'todo'; }); save(); renderPlan(); renderStops(); } };
  $('pDel').onclick = async () => {
    if (!(await ask(`「${p.name}」を削除しますか？元に戻せません。`, '削除する', true))) return;
    S.plans = S.plans.filter((x) => x.id !== p.id); S.planId = S.plans[0] ? S.plans[0].id : null; save(); renderPlan(); renderStops();
  };
  el.querySelectorAll('.stop').forEach((row) => { row.onclick = () => { S.expanded = S.expanded === row.dataset.sid ? null : row.dataset.sid; renderPlan(); }; });
  el.querySelectorAll('[data-act]').forEach((b) => { b.onclick = (ev) => { ev.stopPropagation(); stopAction(b.dataset.act, b.dataset.id); }; });
}
const PS = { sel: new Set() };
function renderPlanKeep() { const y = $('pane-plan').scrollTop; renderPlan(); $('pane-plan').scrollTop = y; }
function stopRow(p, s, i) {
  const nextIdx = nextStopIndex(p);
  const cls = s.status === 'todo' && i === nextIdx ? 'next' : (s.status === 'todo' ? '' : s.status);
  const tags = [s.status !== 'todo' ? `<span class="st-${s.status}">${STATUS[s.status] || ''}${s.doneAt ? ' ' + new Date(s.doneAt).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' }) : ''}</span>` : (s.lastResult ? `<span class="st-${s.lastResult}">前回 ${STATUS[s.lastResult]}</span>` : ''), stopTags(s), s.priority ? '<span class="pri">先に回る</span>' : '', s.approx ? (s.chibanEst ? '<span class="warn">地番から推定（「位置を直す」で確認）</span>' : '<span class="warn">位置はおおよそ（「位置を直す」で修正）</span>') : ''].join('');
  let html = `<div class="stop ${cls} ${PS.sel.has(s.id) ? 'sel' : ''}" data-sid="${s.id}"><span class="ckb" data-ck="${s.id}">${PS.sel.has(s.id) ? '✓' : ''}</span><div class="num">${i + 1}</div><div class="body">
    <div class="name">${esc(stopLabel(s))}</div>${s.name && s.address ? `<div class="addr">${esc(s.address)}</div>` : ''}
    ${s.memo ? `<div class="addr">📝 ${esc(s.memo)}</div>` : ''}<div class="tags">${tags}</div></div></div>`;
  if (S.expanded === s.id) {
    html += `<div class="stop-actions">
      <button data-act="show" data-id="${s.id}">地図で見る</button>
      <button data-act="up" data-id="${s.id}">↑</button><button data-act="down" data-id="${s.id}">↓</button>
      <button data-act="edit" data-id="${s.id}">編集</button>
      <button data-act="move" data-id="${s.id}">位置を直す</button>
      <button data-act="pri" data-id="${s.id}">${s.priority ? '先に回るを外す' : '先に回る'}</button>
      ${s.status !== 'done' ? `<button data-act="st-done" data-id="${s.id}" class="ok">配達完了</button>` : ''}${s.status !== 'absent' ? `<button data-act="st-absent" data-id="${s.id}">不在</button>` : ''}${s.status !== 'redeliver' ? `<button data-act="st-redeliver" data-id="${s.id}">再配達</button>` : ''}${s.status !== 'todo' ? `<button data-act="st-todo" data-id="${s.id}">未配達に戻す</button>` : ''}
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
  if (act.startsWith('st-')) setStatus(s, act.slice(3));
  if (act === 'del') { if (!(await ask(`「${stopLabel(s)}」を削除しますか？`, '削除', true))) return; p.stops.splice(i, 1); }
  if (act === 'edit') return editStopDialog(s);
  if (act === 'move') return placeMode(s, false);
  if (act === 'navhere') {
    // この地点より前の未配達を「あとで」に回さず、順番の先頭へ移動
    p.stops.splice(i, 1); const first = nextStopIndex(p); p.stops.splice(first < 0 ? p.stops.length : first, 0, s); s.status = 'todo';
    save(); renderPlan(); renderStops(); return startNav(false, S.settings.deliveryMode === 'nonav');
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
      const st = addStop(data, true);
      if (f.fav) { saveFavorite(data); const fv = findFavorite(data); if (fv) st.favId = fv.id; }
      closeModal();
      if (st.approx) placeMode(st, true);
    };
  });
}
function editStopDialog(s) {
  openModal(`<h2>配達先の編集</h2>${stopFormHtml(s, false)}
    <p class="small muted">位置を直すときは、地図の番号の印を指で押さえたまま動かしてください。</p>
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
  const fields = { address: o.address || '', name: o.name || '', lat: o.lat, lng: o.lng, posSrc: o.posSrc || '', okihai: o.okihai || '', temp: o.temp || '', kind: o.kind || 'deliver', memo: o.memo || '' };
  if (ex) { Object.assign(ex, fields); ex.uses = (ex.uses || 0) + 1; ex.last = Date.now(); }
  else S.favorites.push(Object.assign({ id: uid(), uses: 1, last: Date.now() }, fields));
  save();
}
function updateFavoriteFromStop(s) {
  const ex = s.favId ? S.favorites.find((f) => f.id === s.favId) : findFavorite(s);
  if (ex) { Object.assign(ex, { address: s.address, name: s.name, okihai: s.okihai, temp: s.temp, kind: s.kind, memo: s.memo, lat: s.lat, lng: s.lng, posSrc: s.posSrc || ex.posSrc }); save(); }
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
function favEdit(f, from) {
  const onMap = from === 'map';
  openModal(`<h2>${onMap ? '登録してある家' : 'よく使う住所の編集'}</h2>${stopFormHtml(f, false).replace(/<label>時間帯<\/label>[\s\S]*?<\/div>/, '').replace(/<label class="collect-row">[\s\S]*?<\/div>/, '')}
    ${onMap ? `<p class="small muted">位置を直すときは、地図の薄い印を指で押さえたまま動かしてください。</p>
    <div class="btngrid"><button id="feAdd" class="ok">今日の配達に追加</button><button id="feDel" class="danger">この家を削除</button></div>` : ''}
    <div class="modal-btns"><button id="feNo">${onMap ? '閉じる' : '戻る'}</button><button id="feOk" class="primary">保存</button></div>`, (box) => {
    bindStopForm(box);
    $('feNo').onclick = onMap ? closeModal : favManager;
    const apply = () => { const v = readStopForm(); if (!v) return false; Object.assign(f, { kind: v.kind, temp: v.temp, okihai: v.okihai, name: v.name, address: v.address, memo: v.memo }); save(); return true; };
    $('feOk').onclick = () => { if (!apply()) return; toast('保存しました'); if (onMap) { closeModal(); renderFavs(); } else favManager(); };
    if (onMap) {
      $('feAdd').onclick = () => {
        if (!apply()) return;
        const p = plan() || newPlan();
        p.stops.push({ id: uid(), name: f.name || '', address: f.address || '', memo: f.memo || '', lat: f.lat, lng: f.lng, approx: false, priority: false, slot: '', kind: f.kind || 'deliver', temp: f.temp || '', okihai: f.okihai || '', collect: 0, favId: f.id, status: 'todo' });
        f.uses = (f.uses || 0) + 1; f.last = Date.now(); p.estimate = null; save(); closeModal(); renderStops(); renderPlan();
        toast(`「${f.name || f.address}」を今日の配達に追加しました（全部で${p.stops.length}件）`, 3000);
      };
      $('feDel').onclick = async () => {
        if (!(await ask(`「${f.name || f.address}」をよく配達する家から削除しますか？`, '削除する', true))) return;
        const i = S.favorites.indexOf(f); if (i < 0) return;
        S.favorites.splice(i, 1); save(); closeModal(); renderFavs();
        undoToast('削除しました', () => { S.favorites.splice(i, 0, f); save(); renderFavs(); });
      };
    }
  });
}

/* ---------- 地図への手書き（Apple Pencil） ---------- */
const DRAW_COLORS = [{ k: '#d62828', label: '赤' }, { k: '#1d4ed8', label: '青' }, { k: '#111111', label: '黒' }, { k: '#15803d', label: '緑' }, { k: '#f59e0b', label: '黄' }];
let drawLayer = null;
const DR = { on: false, color: '#d62828', width: 4, eraser: false, finger: false, cur: null, curLine: null, undo: [], pid: null };
function renderDrawings() {
  if (!drawLayer) return;
  drawLayer.clearLayers();
  if (S.settings.showDrawings === false && !DR.on) return;
  S.drawings.forEach((d) => { L.polyline(d.pts, { color: d.color, weight: d.width, opacity: .9, lineCap: 'round', lineJoin: 'round', interactive: false }).addTo(drawLayer); });
}
function drawToolbar() {
  let tb = $('drawUI');
  if (!tb) { tb = document.createElement('div'); tb.id = 'drawUI'; document.body.appendChild(tb); }
  tb.innerHTML = `<div class="dr-top">✏️ 手書きモード：ペンで書けます。${DR.finger ? '指でも書けます（地図を動かすときは「指で書く」を切る）' : '指で触ると地図が動きます。'}</div>
    <div class="dr-bar">
      <div class="dr-row">${DRAW_COLORS.map((c) => `<button class="dr-col ${!DR.eraser && DR.color === c.k ? 'on' : ''}" data-col="${c.k}" style="--c:${c.k}" title="${c.label}"></button>`).join('')}
        <button class="dr-w ${DR.width === 4 ? 'on' : ''}" data-w="4">細</button><button class="dr-w ${DR.width === 8 ? 'on' : ''}" data-w="8">太</button></div>
      <div class="dr-row">
        <button id="drEraser" class="${DR.eraser ? 'on' : ''}">🧽 消しゴム</button>
        <button id="drFinger" class="${DR.finger ? 'on' : ''}">☝️ 指で書く</button>
        <button id="drUndo" ${DR.undo.length ? '' : 'disabled'}>↩ 戻す</button>
        <button id="drClear">全部消す</button>
        <button id="drDone" class="ok">完了</button>
      </div>
    </div>`;
  tb.classList.remove('hidden');
  tb.querySelectorAll('[data-col]').forEach((b) => { b.onclick = () => { DR.color = b.dataset.col; DR.eraser = false; drawToolbar(); }; });
  tb.querySelectorAll('[data-w]').forEach((b) => { b.onclick = () => { DR.width = +b.dataset.w; drawToolbar(); }; });
  $('drEraser').onclick = () => { DR.eraser = !DR.eraser; drawToolbar(); };
  $('drFinger').onclick = () => { DR.finger = !DR.finger; drawToolbar(); };
  $('drUndo').onclick = () => {
    const a = DR.undo.pop(); if (!a) return;
    if (a.type === 'add') S.drawings = S.drawings.filter((d) => d.id !== a.d.id);
    else S.drawings.push(...a.ds);
    save(); renderDrawings(); drawToolbar();
  };
  $('drClear').onclick = async () => {
    if (!S.drawings.length) return;
    if (!(await ask(`手書きを全部（${S.drawings.length}本）消しますか？`, '全部消す', true))) return;
    DR.undo.push({ type: 'del', ds: S.drawings.slice() }); S.drawings = []; save(); renderDrawings(); drawToolbar();
  };
  $('drDone').onclick = endDraw;
}
function startDraw() {
  if (S.nav) return toast('ナビ中は書き込めません');
  DR.on = true; DR.undo = [];
  $('sheet').classList.add('hidden'); $('hud').classList.add('hidden');
  map.getContainer().classList.add('drawing');
  renderDrawings(); drawToolbar();
}
function endDraw() {
  DR.on = false; DR.cur = null;
  if (DR.curLine) { map.removeLayer(DR.curLine); DR.curLine = null; }
  map.dragging.enable();
  $('drawUI').classList.add('hidden');
  $('sheet').classList.remove('hidden'); $('hud').classList.remove('hidden');
  map.getContainer().classList.remove('drawing');
  renderDrawings();
  if (S.drawings.length) toast('手書きを保存しました');
}
function drawWants(e) { return DR.on && (e.pointerType === 'pen' || e.pointerType === 'mouse' || (DR.finger && e.pointerType === 'touch')); }
function eraseAt(pt) {
  const hit = S.drawings.filter((d) => d.pts.some((p) => map.latLngToContainerPoint(p).distanceTo(pt) < 14));
  if (!hit.length) return;
  const ids = new Set(hit.map((d) => d.id));
  S.drawings = S.drawings.filter((d) => !ids.has(d.id));
  DR.undo.push({ type: 'del', ds: hit }); save(); renderDrawings(); drawToolbar();
}
function setupDrawing() {
  drawLayer = L.layerGroup().addTo(map);
  const el = map.getContainer();
  const ptOf = (e) => { const r = el.getBoundingClientRect(); return L.point(e.clientX - r.left, e.clientY - r.top); };
  el.addEventListener('pointerdown', (e) => {
    if (!drawWants(e) || e.target.closest('.leaflet-control')) return;
    e.preventDefault(); e.stopPropagation();
    map.dragging.disable();
    DR.pid = e.pointerId;
    try { el.setPointerCapture(e.pointerId); } catch (x) { /* なし */ }
    const pt = ptOf(e);
    if (DR.eraser) { DR.cur = { erase: true }; eraseAt(pt); return; }
    const ll = map.containerPointToLatLng(pt);
    DR.cur = { pts: [[ll.lat, ll.lng]], last: pt };
    DR.curLine = L.polyline(DR.cur.pts, { color: DR.color, weight: DR.width, opacity: .9, lineCap: 'round', lineJoin: 'round', interactive: false }).addTo(map);
  }, true);
  el.addEventListener('pointermove', (e) => {
    if (!DR.cur || e.pointerId !== DR.pid) return;
    e.preventDefault(); e.stopPropagation();
    const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
    for (const ev of (evs.length ? evs : [e])) {
      const pt = ptOf(ev);
      if (DR.cur.erase) { eraseAt(pt); continue; }
      if (pt.distanceTo(DR.cur.last) < 2) continue;
      DR.cur.last = pt;
      const ll = map.containerPointToLatLng(pt);
      DR.cur.pts.push([ll.lat, ll.lng]); DR.curLine.addLatLng(ll);
    }
  }, true);
  const finish = (e) => {
    if (!DR.cur || e.pointerId !== DR.pid) return;
    e.preventDefault(); e.stopPropagation();
    if (!DR.cur.erase) {
      let pts = DR.cur.pts;
      if (pts.length === 1) { const p = pts[0]; pts = [p, [p[0] + 0.000002, p[1] + 0.000002]]; } // 点
      const d = { id: uid(), color: DR.color, width: DR.width, pts: pts.map((p) => [+p[0].toFixed(7), +p[1].toFixed(7)]) };
      S.drawings.push(d); DR.undo.push({ type: 'add', d }); save();
      if (DR.curLine) { map.removeLayer(DR.curLine); DR.curLine = null; }
      renderDrawings(); drawToolbar();
    }
    DR.cur = null; DR.pid = null;
    if (!DR.finger) map.dragging.enable();
  };
  el.addEventListener('pointerup', finish, true);
  el.addEventListener('pointercancel', finish, true);
  // iPad で Apple Pencil のタッチが地図を動かさないようにする
  el.addEventListener('touchstart', (e) => {
    if (!DR.on) return;
    const t = e.touches[0];
    if ((t && t.touchType === 'stylus') || DR.finger) { e.stopPropagation(); }
  }, { capture: true, passive: true });
  renderDrawings();
}

/* ---------- 位置を合わせる（地図の真ん中の＋に合わせる） ---------- */
function placeMode(s, isNew) {
  if (S.nav) return;
  const prevSrc = S.settings.mapSource;
  const from = { lat: s.lat, lng: s.lng, approx: s.approx };
  $('sheet').classList.add('hidden'); $('hud').classList.add('hidden');
  setTimeout(() => $('toast').classList.add('hidden'), 50);
  map.setView([s.lat, s.lng], Math.max(map.getZoom(), 18));
  let ov = $('placeUI');
  if (!ov) { ov = document.createElement('div'); ov.id = 'placeUI'; document.body.appendChild(ov); }
  ov.innerHTML = `<div class="pl-top"><b>${esc(stopLabel(s))}</b><br>${isNew ? (s.chibanEst ? '地番から推定した場所です。合っていれば、そのまま「ここに決定」を押してください。' : '番地の位置までは分からないため、地名の中心に置きました。') : ''}地図を指で動かして、<b>真ん中の＋</b>を家に合わせてください。</div>
    <svg class="pl-cross" viewBox="0 0 80 80"><path d="M40 4V32M40 48V76M4 40H32M48 40H76" stroke="#fff" stroke-width="9" stroke-linecap="round"/><path d="M40 4V32M40 48V76M4 40H32M48 40H76" stroke="#c8442f" stroke-width="4" stroke-linecap="round"/><circle cx="40" cy="40" r="4" fill="#c8442f" stroke="#fff" stroke-width="2"/></svg>
    <div class="pl-btns"><button id="plPhoto">${S.settings.mapSource === 'gsi_photo' ? '🗺 地図に戻す' : '📷 航空写真'}</button><button id="plHere">📍 今いる場所</button><button id="plNo">やめる</button><button id="plOk" class="ok">ここに決定</button></div>`;
  ov.classList.remove('hidden');
  $('btnFollow').classList.add('hidden');
  const close = () => { ov.classList.add('hidden'); $('sheet').classList.remove('hidden'); $('hud').classList.remove('hidden'); if (S.settings.mapSource !== prevSrc) { S.settings.mapSource = prevSrc; save(); setBaseLayer(); } };
  $('plPhoto').onclick = () => { S.settings.mapSource = S.settings.mapSource === 'gsi_photo' ? prevSrc : 'gsi_photo'; setBaseLayer(); $('plPhoto').textContent = S.settings.mapSource === 'gsi_photo' ? '🗺 地図に戻す' : '📷 航空写真'; };
  $('plHere').onclick = async () => { const p = await getPos(8000); if (!p) return toast('現在地が分かりません'); map.setView([p.lat, p.lng], 19); };
  $('plNo').onclick = close;
  $('plOk').onclick = () => {
    const c = map.getCenter();
    s.lat = c.lat; s.lng = c.lng; s.approx = false; s.posSrc = 'user'; s.chibanEst = false;
    const p = plan(); if (p) p.estimate = null;
    updateFavoriteFromStop(s); save(); close(); renderPlan(); renderStops();
    undoToast(`「${stopLabel(s)}」の位置を決めました`, () => { Object.assign(s, from); updateFavoriteFromStop(s); save(); renderPlan(); renderStops(); });
  };
}
async function navFixPosition() {
  const nav = S.nav, p = plan(); if (!nav) return;
  const s = p.stops[nav.idx]; if (!s) return;
  const pos = nav.sim ? nav.simPos : S.pos;
  if (!pos) return toast('現在地が分かりません');
  if (!(await ask(`今いる場所を「${stopLabel(s)}」の正しい位置として登録しますか？（よく使う住所にも反映します）`, '登録する'))) return;
  const from = { lat: s.lat, lng: s.lng, approx: s.approx };
  s.lat = pos.lat; s.lng = pos.lng; s.approx = false; s.posSrc = 'user'; s.chibanEst = false; updateFavoriteFromStop(s); save(); renderStops();
  undoToast('今いる場所を正しい位置として登録しました', () => { Object.assign(s, from); updateFavoriteFromStop(s); save(); renderStops(); });
}

/* ---------- 地番データ（法務省 登記所備付地図）から位置を推定 ---------- */
let CHIBAN = null; // {sheets:[], aza:{字:Map(地番→[sheet,x,y,size])}}
async function loadChiban() {
  try {
    const d = await (await fetch('chiban.json')).json();
    const aza = {};
    Object.entries(d.aza).forEach(([a, s]) => { const m = new Map(); s.split(';').forEach((r) => { const p = r.split(','); m.set(p[0], [+p[1], +p[2], +p[3], +p[4]]); }); aza[a] = m; });
    CHIBAN = { sheets: d.sheets, aza, src: d.src };
  } catch (e) { CHIBAN = null; }
}
function normChiban(s) {
  s = String(s || '').normalize('NFKC').replace(/\s/g, '').replace(/[ー－‐−―の之]/g, '-').replace(/番地|番/g, '-').replace(/号$/, '').replace(/-+$/, '').replace(/-+/g, '-');
  return s;
}
/* 住所から 字 と 地番 を取り出し、データの中から探す */
function findParcel(address) {
  if (!CHIBAN || !address) return null;
  const a = String(address).normalize('NFKC').replace(/\s/g, ' ');
  const i = a.indexOf(HOME_AREA.town); if (i < 0) return null;
  const rest = a.slice(i + HOME_AREA.town.length).replace(/^大字|^字/, '');
  const aza = Object.keys(CHIBAN.aza).sort((x, y) => y.length - x.length).find((k) => normAddr(rest).startsWith(normAddr(k)));
  if (!aza) return null;
  const numPart = rest.slice(rest.indexOf(aza.slice(-1)) + 1).trim();
  const ch = normChiban((numPart.match(/[0-9０-９][0-9０-９\-ー－‐−の番地号]*/) || [])[0] || '');
  if (!ch) return null;
  const m = CHIBAN.aza[aza];
  let hit = m.get(ch), used = ch;
  if (!hit) { const base = ch.split('-')[0]; if (m.get(base)) { hit = m.get(base); used = base; } else { for (const [k, v] of m) if (k.split('-')[0] === base) { hit = v; used = k; break; } } }
  if (!hit) return null;
  return { aza, chiban: used, asked: ch, sheet: hit[0], x: hit[1], y: hit[2], size: hit[3] };
}
/* 目印（ユーザーが正しく合わせた家）から、図面ごとの重ね合わせを計算 */
let calibCache = null;
function controlPoints() {
  const items = [];
  S.favorites.forEach((f) => items.push(f));
  S.plans.forEach((p) => p.stops.forEach((s) => items.push(s)));
  const byKey = new Map();
  items.forEach((o) => {
    if (o.posSrc !== 'user' || o.lat == null) return;
    const pc = findParcel(o.address); if (!pc) return;
    byKey.set(pc.aza + '|' + pc.chiban, { sheet: pc.sheet, x: pc.x, y: pc.y, lat: o.lat, lng: o.lng });
  });
  return [...byKey.values()];
}
function calib() {
  if (calibCache) return calibCache;
  const bySheet = {};
  controlPoints().forEach((c) => (bySheet[c.sheet] = bySheet[c.sheet] || []).push(c));
  const out = {};
  Object.entries(bySheet).forEach(([sh, pts]) => { const t = fitSheet(pts); if (t) out[sh] = t; });
  calibCache = out; return out;
}
function fitSheet(pts) {
  if (pts.length < 2) return null;
  const lat0 = pts.reduce((a, p) => a + p.lat, 0) / pts.length, lng0 = pts.reduce((a, p) => a + p.lng, 0) / pts.length;
  const kx = 111320 * Math.cos(lat0 * Math.PI / 180), ky = 110540;
  // 図面の X=北, Y=東 として右手系に（u=Y, v=X）
  let P = pts.map((p) => ({ u: p.y, v: p.x, E: (p.lng - lng0) * kx, N: (p.lat - lat0) * ky }));
  const fit = (P) => {
    if (P.length < 5) { // 相似変換（回転・縮尺・移動）を最小二乗で。目印が少ないうちは形を崩さない
      const n = P.length, mu = P.reduce((a, p) => a + p.u, 0) / n, mv = P.reduce((a, p) => a + p.v, 0) / n, mE = P.reduce((a, p) => a + p.E, 0) / n, mN = P.reduce((a, p) => a + p.N, 0) / n;
      let re = 0, im = 0, den = 0;
      P.forEach((p) => { const su = p.u - mu, sv = p.v - mv, dE = p.E - mE, dN = p.N - mN; re += dE * su + dN * sv; im += dN * su - dE * sv; den += su * su + sv * sv; });
      if (den < 1) return null; re /= den; im /= den;
      return { f: (u, v) => [re * (u - mu) - im * (v - mv) + mE, im * (u - mu) + re * (v - mv) + mN], scale: Math.hypot(re, im) };
    }
    // アフィン（最小二乗）
    let S = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], bE = [0, 0, 0], bN = [0, 0, 0];
    P.forEach((p) => { const r = [p.u, p.v, 1]; for (let i = 0; i < 3; i++) { for (let j = 0; j < 3; j++) S[i][j] += r[i] * r[j]; bE[i] += r[i] * p.E; bN[i] += r[i] * p.N; } });
    const solve = (A, b) => { const M = A.map((r, i) => r.concat([b[i]])); for (let c = 0; c < 3; c++) { let piv = c; for (let r = c + 1; r < 3; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r; [M[c], M[piv]] = [M[piv], M[c]]; if (Math.abs(M[c][c]) < 1e-9) return null; for (let r = 0; r < 3; r++) if (r !== c) { const f = M[r][c] / M[c][c]; for (let k = c; k < 4; k++) M[r][k] -= f * M[c][k]; } } return [M[0][3] / M[0][0], M[1][3] / M[1][1], M[2][3] / M[2][2]]; };
    const e = solve(S, bE), n = solve(S, bN);
    if (!e || !n) return null;
    return { f: (u, v) => [e[0] * u + e[1] * v + e[2], n[0] * u + n[1] * v + n[2]], scale: Math.sqrt(Math.abs(e[0] * n[1] - e[1] * n[0])) };
  };
  let t = fit(P); if (!t) return null;
  const resid = (t) => P.map((p) => { const [E, N] = t.f(p.u, p.v); return Math.hypot(E - p.E, N - p.N); });
  let r = resid(t);
  if (P.length >= 4) { const worst = r.indexOf(Math.max(...r)); if (r[worst] > 100) { P = P.filter((_, i) => i !== worst); t = fit(P) || t; r = resid(t); } }
  if (t.scale < 0.3 || t.scale > 3) return null; // おかしな目印は使わない
  return { n: P.length, err: Math.round(Math.max(0, ...r)), toLatLng: (x, y) => { const [E, N] = t.f(y, x); return { lat: lat0 + N / ky, lng: lng0 + E / kx }; } };
}
/* 住所 → 推定位置（目印が足りなければ null） */
function estimateFromChiban(address) {
  const pc = findParcel(address); if (!pc) return null;
  const t = calib()[pc.sheet];
  if (!t) return { parcel: pc, pos: null };
  const ll = t.toLatLng(pc.x, pc.y);
  return { parcel: pc, pos: ll, n: t.n };
}
function chibanStatusHtml() {
  if (!CHIBAN) return '地番データを読み込めませんでした';
  const c = calib(), cps = controlPoints();
  const rows = Object.keys(CHIBAN.aza).map((a) => {
    const sheets = [...new Set([...CHIBAN.aza[a].values()].map((v) => v[0]))];
    const ok = sheets.filter((s) => c[s]).length;
    const big = sheets.filter((s) => [...CHIBAN.aza[a].values()].filter((v) => v[0] === s).length >= 100);
    const okBig = big.filter((s) => c[s]).length;
    const pts = cps.filter((p) => sheets.includes(p.sheet)).length;
    return `<div class="cb-row"><b>${esc(a)}</b><span>${okBig >= big.length && big.length ? '✅ 推定できます' : okBig ? `一部推定できます（${okBig}/${big.length}枚）` : `目印 ${pts} 軒（あと${Math.max(0, 2 - pts)}軒〜）`}</span></div>`;
  }).join('');
  return rows;
}

/* ---------- 字ごとに選んで、まとめて追加 ---------- */
function homeTowns() { return ADDR.filter((a) => a.city === HOME_AREA.city && a.group === HOME_AREA.town); }
function favAza(f, towns) {
  towns = towns || homeTowns();
  const addr = normAddr(f.address || '');
  let best = null;
  towns.forEach((t) => { const k = normAddr(t.leaf); if (k && addr.includes(normAddr(HOME_AREA.town) + k) && (!best || k.length > normAddr(best.leaf).length)) best = t; });
  if (!best) towns.forEach((t) => { const k = normAddr(t.leaf); if (k.length >= 2 && addr.includes(k) && (!best || k.length > normAddr(best.leaf).length)) best = t; });
  if (best) return best.leaf;
  if (f.lat && /信更/.test(f.address || '')) {
    let nb = null, nd = Infinity;
    towns.forEach((t) => { const d = GC.hav(f.lat, f.lng, t.lat, t.lng); if (d < nd) { nd = d; nb = t; } });
    if (nb && nd < 2500) return nb.leaf;
  }
  return 'その他';
}
const FS = { sel: new Set() };
function inTodayPlan(f) { const p = plan(); return !!p && p.stops.some((s) => s.favId === f.id || (s.name === f.name && s.address === f.address)); }
function favGroupsHtml(filter) {
  const towns = homeTowns();
  const order = towns.map((t) => t.leaf).concat(['その他']);
  const list = favList(filter);
  const groups = {};
  list.forEach((f) => { const a = favAza(f, towns); (groups[a] = groups[a] || []).push(f); });
  const open = new Set(S.settings.openAza || []);
  const q = (filter || '').trim();
  const html = order.filter((a) => groups[a] || (!q && a !== 'その他')).map((a) => {
    if (!groups[a]) return `<div class="aza empty"><div class="aza-h"><span>　 ${esc(a)}</span><em>0軒</em></div></div>`;
    const fs = groups[a].sort((x, y) => (x.name || x.address).localeCompare(y.name || y.address, 'ja'));
    const isOpen = q ? true : open.has(a);
    const nSel = fs.filter((f) => FS.sel.has(f.id)).length, nIn = fs.filter(inTodayPlan).length;
    return `<div class="aza">
      <button class="aza-h ${isOpen ? 'open' : ''}" data-aza="${esc(a)}"><span>${isOpen ? '▼' : '▶'} ${esc(a)}</span><em>${fs.length}軒${nIn ? `・追加済み ${nIn}` : ''}${nSel ? `・<b>選択 ${nSel}</b>` : ''}</em></button>
      ${isOpen ? `<div class="aza-b">${(() => { const can = fs.filter((f) => !inTodayPlan(f)); const nOn = can.filter((f) => FS.sel.has(f.id)).length; const st = can.length && nOn === can.length ? 'on' : nOn ? 'part' : ''; return can.length ? `<div class="fsel fall ${st}" data-azall="${esc(a)}"><span class="ck">${st === 'on' ? '✓' : st === 'part' ? '－' : ''}</span><div class="body"><div class="name">全部選択</div><div class="addr">${nOn ? `${nOn}軒を選んでいます（外したい家だけ押してください）` : `${can.length}軒をまとめて選びます`}</div></div></div>` : ''; })()}${fs.map((f) => { const added = inTodayPlan(f), on = FS.sel.has(f.id); return `<div class="fsel ${on ? 'on' : ''} ${added ? 'added' : ''}" data-fs="${f.id}">
          <span class="ck">${added ? '済' : on ? '✓' : ''}</span>
          <div class="body"><div class="name">${esc(f.name || f.address)}</div>${f.name ? `<div class="addr">${esc((f.address || '').replace(HOME_AREA.city + HOME_AREA.town, ''))}</div>` : ''}<div class="tags">${stopTags(f)}</div></div></div>`; }).join('')}
</div>` : ''}
    </div>`;
  }).join('');
  return html || '<p class="muted">見つかりません</p>';
}
function bindFavGroups() {
  const box = $('fvList'); if (!box) return;
  box.querySelectorAll('[data-aza]').forEach((b) => {
    b.onclick = () => {
      const a = b.dataset.aza, open = new Set(S.settings.openAza || []);
      open.has(a) ? open.delete(a) : open.add(a);
      S.settings.openAza = [...open]; save(); drawFavGroups();
    };
  });
  box.querySelectorAll('[data-fs]').forEach((d) => {
    d.onclick = () => {
      const f = S.favorites.find((x) => x.id === d.dataset.fs); if (!f) return;
      if (inTodayPlan(f)) return toast('この家は、もう今日の配達先に入っています');
      FS.sel.has(f.id) ? FS.sel.delete(f.id) : FS.sel.add(f.id);
      drawFavGroups();
    };
  });
  box.querySelectorAll('[data-azall]').forEach((b) => {
    b.onclick = () => {
      const towns = homeTowns();
      const fs = favList($('fvQ') ? $('fvQ').value : '').filter((f) => favAza(f, towns) === b.dataset.azall && !inTodayPlan(f));
      const allOn = fs.every((f) => FS.sel.has(f.id));
      fs.forEach((f) => (allOn ? FS.sel.delete(f.id) : FS.sel.add(f.id)));
      drawFavGroups();
    };
  });
  const bar = $('fsBar');
  if (bar) {
    bar.classList.toggle('hidden', FS.sel.size === 0);
    $('fsCount').textContent = FS.sel.size;
  }
}
function drawFavGroups() {
  const box = $('fvList'); if (!box) return;
  const y = $('pane-add').scrollTop;
  box.innerHTML = favGroupsHtml($('fvQ') ? $('fvQ').value : '');
  bindFavGroups();
  $('pane-add').scrollTop = y;
}
const SLOT_OPTS = () => TIME_SLOTS.map((t) => `<option value="${t.k}">${t.label}</option>`).join('');
function batchAddDialog() {
  const fs = [...FS.sel].map((id) => S.favorites.find((f) => f.id === id)).filter(Boolean);
  if (!fs.length) return;
  openModal(`<h2>${fs.length}件を今日の配達に追加</h2>
    <p class="small muted">今日だけの情報があれば選んでください。何も選ばなければ「時間帯：指定なし」で追加します。置き配や詳しい情報は、前回の内容のままです。</p>
    <div class="ba-all"><span>全部に同じ時間帯：</span><select id="baAll"><option value="-">選ばない</option>${SLOT_OPTS()}</select></div>
    ${fs.map((f) => `<div class="ba-row" data-ba="${f.id}">
      <div class="name">${esc(f.name || f.address)}</div>
      <div class="ba-ctl">
        <select class="ba-slot">${SLOT_OPTS()}</select>
        <select class="ba-temp">${TEMPS.map((t) => `<option value="${t.k}" ${(f.temp || '') === t.k ? 'selected' : ''}>${t.label}</option>`).join('')}</select>
        <select class="ba-kind">${KINDS.map((t) => `<option value="${t.k}" ${(f.kind || 'deliver') === t.k ? 'selected' : ''}>${t.label}</option>`).join('')}</select>
        <div class="ba-yen"><input class="ba-collect" inputmode="numeric" placeholder="コレクト"><span>円</span></div>
      </div></div>`).join('')}
    <div class="modal-btns"><button id="baNo">戻る</button><button id="baOk" class="primary">${fs.length}件を追加</button></div>`, (box) => {
    $('baAll').onchange = (e) => { if (e.target.value !== '-') box.querySelectorAll('.ba-slot').forEach((s) => { s.value = e.target.value; }); };
    $('baNo').onclick = closeModal;
    $('baOk').onclick = () => {
      const p = plan() || newPlan();
      box.querySelectorAll('[data-ba]').forEach((row) => {
        const f = S.favorites.find((x) => x.id === row.dataset.ba); if (!f) return;
        const collect = parseInt((row.querySelector('.ba-collect').value || '').normalize('NFKC').replace(/[^0-9]/g, ''), 10) || 0;
        p.stops.push({ id: uid(), name: f.name || '', address: f.address || '', memo: f.memo || '', lat: f.lat, lng: f.lng, approx: false, priority: false,
          slot: row.querySelector('.ba-slot').value, kind: row.querySelector('.ba-kind').value, temp: row.querySelector('.ba-temp').value,
          okihai: f.okihai || '', collect, favId: f.id, status: 'todo' });
        f.uses = (f.uses || 0) + 1; f.last = Date.now();
      });
      p.estimate = null; FS.sel.clear(); save(); closeModal();
      renderStops(); renderPlan(); renderAdd();
      toast(`${fs.length}件を追加しました（全部で${p.stops.length}件）`, 3500);
    };
  });
}

/* ---------- 検索した場所を地図に出す（下のパネルに隠れないように） ---------- */
let searchPin = null;
function focusVisible(lat, lng, zoom) {
  const sh = $('sheet'), hidden = sh.classList.contains('hidden');
  const cover = hidden ? 0 : sh.getBoundingClientRect().height;
  map.setView([lat, lng], zoom, { animate: false });
  if (cover > 0) map.panBy([0, cover / 2], { animate: false });
}
function clearSearchPin() { if (searchPin) { map.removeLayer(searchPin); searchPin = null; } }
function showSearchPin(r, onAdd) {
  clearSearchPin();
  $('sheet').classList.add('collapsed');
  setTimeout(() => {
    map.invalidateSize();
    focusVisible(r.lat, r.lng, r.approx ? 16 : 18);
    searchPin = L.marker([r.lat, r.lng], { icon: L.divIcon({ className: 'search-pin', html: '<div class="sp-dot"></div>', iconSize: [30, 30], iconAnchor: [15, 15] }), zIndexOffset: 2000 }).addTo(map);
    const box = document.createElement('div'); box.className = 'sp-pop';
    box.innerHTML = `<b>${esc(r.label)}</b>${r.approx ? '<div class="small muted">地名の中心です（番地の位置ではありません）</div>' : ''}<div class="sp-btns"><button class="sp-no">閉じる</button><button class="sp-add primary">ここに追加</button></div>`;
    box.querySelector('.sp-no').onclick = () => clearSearchPin();
    box.querySelector('.sp-add').onclick = () => { clearSearchPin(); onAdd(); };
    searchPin.bindPopup(box, { closeButton: false, autoPan: false, offset: [0, -10] }).openPopup();
  }, 250);
}

/* ---------- 地点を追加 ---------- */
function renderAdd() {
  const towns = ADDR.filter((a) => a.city === HOME_AREA.city && a.group === HOME_AREA.town);
  const lastTown = S.settings.lastTown || '氷ノ田';
  $('pane-add').innerHTML = `
    <h3>よく配達する家（${S.favorites.length}軒）</h3>
    ${S.favorites.length ? `<p class="small muted">字を開いて、今日の荷物の家を押して選び、下の「追加」を押してください。</p>${withMic('<input id="fvQ" placeholder="名前や住所で探す">', 'fvQ')}<div id="fvList">${favGroupsHtml('')}</div><button id="fvManage" style="width:100%;margin-top:8px">よく配達する家を編集する</button>` : '<p class="small muted">一度登録した家は、自動でここに字ごとに入ります。次からは選んで「追加」を押すだけです。</p>'}
    <h3>新しい住所を追加</h3>
    <div class="row"><b style="flex:0 0 auto">${esc(HOME_AREA.city + HOME_AREA.town)}</b><select id="adTown">${towns.map((t) => `<option ${t.leaf === lastTown ? 'selected' : ''}>${esc(t.leaf)}</option>`).join('')}</select></div>
    <label>番地</label>${withMic('<input id="adNum" inputmode="text" placeholder="例：1234-5">', 'adNum')}
    <label>名前</label>${withMic('<input id="adName" placeholder="例：山田様">', 'adName')}
    <button id="adGo" class="primary" style="width:100%;margin-top:10px">この住所で追加</button>
    <h3>ほかの方法で探す</h3>
    ${withMic('<input id="aQ" placeholder="ほかの地域の住所や地名" enterkeyhint="search">', 'aQ')}
    <button id="aGo" style="width:100%;margin-top:6px">検索</button>
    <div id="aRes"></div>
    <div class="btngrid" style="margin-top:10px"><button id="aMap">地図をタップして追加</button><button id="aHere">今いる場所を追加</button><button id="aBulk">まとめて登録</button><button id="aHz">注意地点を追加</button></div>
    <div id="fsBar" class="hidden"><button id="fsClear">選択をやめる</button><button id="fsAdd" class="ok">選んだ <b id="fsCount">0</b> 件を追加</button></div>`;
  bindMics($('pane-add'));
  bindFavGroups();
  $('fsAdd').onclick = batchAddDialog;
  $('fsClear').onclick = () => { FS.sel.clear(); drawFavGroups(); };
  $('adGo').onclick = async () => {
    const town = $('adTown').value, num = $('adNum').value.trim().normalize('NFKC'), name = $('adName').value.trim();
    S.settings.lastTown = town; save();
    const address = HOME_AREA.city + HOME_AREA.town + town + (num ? ' ' + num : '');
    const base = towns.find((t) => t.leaf === town);
    let pos = { lat: base.lat, lng: base.lng, approx: true };
    const est = num ? estimateFromChiban(address) : null;
    if (est && est.pos) pos = { lat: est.pos.lat, lng: est.pos.lng, approx: true, chibanEst: true, posSrc: 'chiban' };
    else if (num && isOnline()) {
      $('adGo').disabled = true; $('adGo').textContent = '場所を調べています…';
      const on = await onlineSearch(address.replace(' ', ''));
      const hit = on.find((r) => r.label.includes(town) && /\d/.test(r.label));
      if (hit) pos = { lat: hit.lat, lng: hit.lng, approx: false };
      $('adGo').disabled = false; $('adGo').textContent = 'この住所で追加';
    }
    const fav = findFavorite({ address, name, lat: pos.lat, lng: pos.lng });
    map.setView([pos.lat, pos.lng], 17);
    newStopDialog(Object.assign({ address, name }, fav ? { okihai: fav.okihai, temp: fav.temp, kind: fav.kind, memo: fav.memo, lat: fav.lat, lng: fav.lng, approx: false, favId: fav.id } : pos));

  };
  if ($('fvQ')) $('fvQ').oninput = drawFavGroups;
  if ($('fvManage')) $('fvManage').onclick = favManager;
  const go = async () => {
    const q = $('aQ').value.trim(); if (!q) return;
    $('aRes').innerHTML = '<p class="muted">検索中…</p>';
    const [on, off] = [await onlineSearch(q), offlineSearch(q)];
    const list = on.concat(off);
    $('aRes').innerHTML = list.length ? list.map((r, i) => `<div class="result" data-i="${i}"><span class="src ${r.src === 'off' ? 'off' : ''}">${r.src === 'off' ? '町名' : '住所'}</span>${esc(r.label)}</div>`).join('')
      : '<p class="muted">見つかりませんでした。「地図をタップして追加」もお使いください。</p>';
    $('aRes').querySelectorAll('.result').forEach((d) => {
      d.onclick = () => { const r = list[+d.dataset.i]; showSearchPin(r, () => newStopDialog({ address: /\d/.test(q) && r.approx ? q : r.label, lat: r.lat, lng: r.lng, approx: r.approx })); };
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
        const ce = estimateFromChiban(parts[0]);
        const r = ce && ce.pos ? { lat: ce.pos.lat, lng: ce.pos.lng, approx: true, est: true } : await geocode(parts[0]);
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
function optimizePlan() {
  const p = plan(); if (!p) return;
  if (p.stops.filter((s) => s.status !== 'done').length < 2) return toast('2件以上必要です');
  const cur = S.settings.routeMode || 'slot';
  openModal(`<h2>回り方を選んでください</h2>${ROUTE_MODES.map((m) => `<button class="mode-btn ${m.k === cur ? 'on' : ''}" data-mode="${m.k}"><b>${m.label}</b><span>${m.desc}</span></button>`).join('')}
    <div class="modal-btns"><button id="rmNo">やめる</button></div>`, (box) => {
    $('rmNo').onclick = closeModal;
    box.querySelectorAll('[data-mode]').forEach((b) => { b.onclick = () => { S.settings.routeMode = b.dataset.mode; save(); closeModal(); runOptimize(b.dataset.mode); }; });
  });
}
async function runOptimize(mode) {
  const p = plan(); if (!p) return;
  const todo = p.stops.filter((s) => s.status !== 'done');
  let start;
  if (S.settings.startMode === 'home' && S.settings.home) start = S.settings.home;
  else { toast('現在地を確認しています…'); start = await getPos(10000); }
  if (!start) { start = todo[0]; toast('現在地が分からないため、1件目から計算します'); }
  openModal(`<h2>順番を決めています</h2><div class="progress"><div id="opBar"></div></div><div id="opMsg" class="small">準備中…</div>`);
  let res, road = false;
  try {
    if (S.graphMeta) {
      res = await call('optimize', { opts: { start: { lat: start.lat, lng: start.lng }, stops: todo.map((s) => ({ lat: s.lat, lng: s.lng, priority: s.priority, rank: slotRank(s.slot) })), end: S.settings.endMode, mode } }, (pr) => {
        if (pr.total) $('opBar').style.width = (pr.done / pr.total * 100) + '%';
        $('opMsg').textContent = pr.msg || '';
      });
      road = true;
    } else {
      res = straightOptimize(start, todo, mode);
    }
  } catch (e) { closeModal(); return toast('計算できませんでした：' + e.message, 5000); }
  closeModal();
  const ordered = res.order.map((k) => todo[k]);
  p.stops = p.stops.filter((s) => s.status === 'done').concat(ordered);
  p.estimate = { totalSec: res.totalSec, road, mode, at: Date.now() };
  save(); renderPlan(); renderStops();
  const far = (res.snapDist || []).slice(1).map((d, k) => (d != null && d > 300 ? todo[k] : null)).filter(Boolean);
  let msg = `「${(ROUTE_MODES.find((m) => m.k === mode) || {}).label}」で順番を決めました。目安 約${fmtDur(res.totalSec)}`;
  if (!road) msg += '（道路データがないため直線距離で概算）';
  if (far.length) msg += `。道路から300m以上離れた地点が${far.length}件あります`;
  toast(msg, 5000);
  const b = L.latLngBounds(ordered.map((s) => [s.lat, s.lng]).concat([[start.lat, start.lng]]));
  map.fitBounds(b, { padding: [30, 30] });
}
function straightOptimize(start, stops, mode) {
  const pts = [start].concat(stops), n = pts.length, M = new Float64Array(n * n);
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) M[i * n + j] = GC.hav(pts[i].lat, pts[i].lng, pts[j].lat, pts[j].lng) * 1.4 / 8.3;
  const end = S.settings.endMode === 'return' ? 0 : -1;
  const order = GC.orderByMode(M, n, 0, stops.map((s) => ({ rank: slotRank(s.slot), priority: !!s.priority })), end, mode || 'slot', 1500);
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

function setStatus(s, st) {
  if (st === 'todo') { if (s.status === 'absent' || s.status === 'redeliver') s.lastResult = s.status; s.status = 'todo'; s.doneAt = null; }
  else { s.status = st; s.doneAt = Date.now(); (s.log = s.log || []).push({ st, at: s.doneAt }); }
  save();
}
function chooseDeliveryMode() {
  const cur = S.settings.deliveryMode || 'nonav';
  openModal(`<h2>配達のしかた</h2>
    <button class="mode-btn ${cur === 'nonav' ? 'on' : ''}" data-dm="nonav"><b>📋 ナビなしで配達</b><span>地図と配達先だけを表示。道案内や音声はなし。地図の印を押すと、その配達先に切り替わります</span></button>
    <button class="mode-btn ${cur === 'nav' ? 'on' : ''}" data-dm="nav"><b>🚗 ナビありで配達</b><span>道案内の矢印と音声で、次の配達先まで案内します</span></button>
    <div class="modal-btns"><button id="dmNo">やめる</button></div>`, (box) => {
    $('dmNo').onclick = closeModal;
    box.querySelectorAll('[data-dm]').forEach((b) => { b.onclick = () => { S.settings.deliveryMode = b.dataset.dm; save(); closeModal(); startNav(false, b.dataset.dm === 'nonav'); }; });
  });
}
async function startNav(sim, nonav) {
  const p = plan(); if (!p) return;
  const idx = nextStopIndex(p);
  if (idx < 0) { const rest = p.stops.filter((s) => s.status !== 'done' && s.status !== 'todo'); if (!rest.length) return toast('未配達の地点がありません'); rest.forEach((s) => setStatus(s, 'todo')); }
  if (!nonav) speak('ナビを開始します', true); // iPhone はボタン操作の直後に一度話させる必要がある
  S.nav = { idx: nextStopIndex(p), route: null, ann: new Set(), hzAnn: new Set(), off: 0, lastReroute: 0, follow: !nonav, sim: !!sim, arrived: false, nonav: !!nonav };
  $('sheet').classList.add('hidden'); $('hud').classList.add('hidden');
  $('navBanner').classList.toggle('hidden', !!nonav); $('navBar').classList.remove('hidden');
  $('navBar').classList.toggle('nonav', !!nonav);
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
  const p = plan();
  if (p && p.stops.length && p.stops.every((x) => x.status && x.status !== 'todo')) setTimeout(offerDailyFileBackup, 1200);
}
async function routeToCurrent(first) {
  const nav = S.nav, p = plan(); if (!nav) return;
  const target = p.stops[nav.idx];
  if (!target) return finishAll();
  $('nvNext').textContent = `${nav.idx + 1}/${p.stops.length}　${stopLabel(target)}`;
  if (nav.nonav) {
    nav.route = null; drawRoute(); renderStops();
    const me = S.pos;
    if (me) map.fitBounds(L.latLngBounds([[me.lat, me.lng], [target.lat, target.lng]]), { padding: [60, 60], maxZoom: 17 });
    else map.setView([target.lat, target.lng], Math.max(map.getZoom(), 16));
    updateNav(); return;
  }
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
  if (S.settings.follow !== 'manual' && !S.pos) map.fitBounds(routeLine.getBounds(), { padding: [40, 40], maxZoom: 17 });
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
  if (nav.nonav) {
    $('nvDone').textContent = target.kind === 'pickup' ? '集荷完了' : '配達完了';
    $('nvTags').innerHTML = stopTags(target) + (target.memo ? `<div class="nvmemo">📝 ${esc(target.memo)}</div>` : '');
    $('nvSub').textContent = pos ? `ここから直線で ${fmtDist(GC.hav(pos.lat, pos.lng, target.lat, target.lng))}　${esc(target.address || '')}` : (target.address || '');
    if (pos) S.hazards.forEach((h) => {
      if (!nav.hzAnn.has(h.id) && GC.hav(pos.lat, pos.lng, h.lat, h.lng) < 150) {
        nav.hzAnn.add(h.id); const t = HAZARD_TYPES[h.type] || HAZARD_TYPES.other;
        toast(`${t.icon} 近くに ${t.name}${h.memo ? '：' + h.memo : ''}`, 5000); speak(`近くに、${t.name}があります`);
      }
    });
    return;
  }
  if (!pos || !r) return;
  if (S.settings.follow !== 'manual') map.setView([pos.lat, pos.lng], Math.max(map.getZoom(), 16), { animate: true });
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
  $('nvDone').textContent = target.kind === 'pickup' ? '集荷完了' : '配達完了';
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
  if (s) setStatus(s, status);
  if (status !== 'done') toast(`「${stopLabel(s)}」を${STATUS[status]}にしました`);
  const next = nextStopIndex(p);
  if (next < 0) return finishAll();
  nav.idx = next;
  renderStops();
  if (!nav.nonav) speak(`次は、${stopLabel(p.stops[next])}です${p.stops[next].kind === 'pickup' ? '。集荷です' : ''}`);
  if (nav.sim && nav.route) nav.simPos = nav.simPos || null;
  await routeToCurrent(false);
}
function finishAll() {
  const p = plan();
  const rest = p ? p.stops.filter((s) => s.status === 'absent' || s.status === 'redeliver' || s.status === 'skip') : [];
  if (rest.length) {
    const a = rest.filter((s) => s.status === 'absent').length, r = rest.filter((s) => s.status === 'redeliver').length;
    if (!S.nav.nonav) speak(`未配達が${rest.length}件残っています`);
    openModal(`<h2>未配達が ${rest.length} 件残っています</h2><p>${a ? `不在 ${a} 件　` : ''}${r ? `再配達 ${r} 件` : ''}</p>
      <div class="modal-btns"><button id="faEnd">終了する</button><button id="faAgain" class="primary">もう一度回る</button></div>`, () => {
      $('faEnd').onclick = () => { closeModal(); endNav(); };
      $('faAgain').onclick = () => { closeModal(); rest.forEach((s) => setStatus(s, 'todo')); S.nav.idx = nextStopIndex(p); renderStops(); routeToCurrent(false); };
    });
    return;
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
  const area = S.settings.area;
  dl = { stop: false, done: 0, total: 0, fail: 0 };
  $('dlTiles').textContent = '中断する';
  const queue = [];
  for (const [src, maxZ] of [[BASE_MAP, S.settings.maxZoom], [PHOTO_MAP, S.settings.photoZoom || 17]]) {
    for (let z = 8; z <= maxZ; z++) {
      const t = tilesFor(area, z);
      const have = new Set(await DB.keys('tiles', DB.prefix(`${src}/${z}/`)));
      for (let x = t.x0; x <= t.x1; x++) for (let y = t.y0; y <= t.y1; y++) { dl.total++; const k = tileKey(src, z, x, y); if (have.has(k)) dl.done++; else queue.push([src, z, x, y]); }
    }
  }
  const batch = [];
  const flush = async () => { if (batch.length) { const b = batch.splice(0); await DB.putMany('tiles', b); } };
  const show = () => { $('dlBar').style.width = (dl.done / dl.total * 100) + '%'; $('dlMsg').textContent = `${dl.done.toLocaleString()} / ${dl.total.toLocaleString()} 枚（地図と航空写真）${dl.fail ? `（失敗 ${dl.fail}）` : ''}`; };
  show();
  let qi = 0;
  const workerFn = async () => {
    while (qi < queue.length && !dl.stop) {
      const [src, z, x, y] = queue[qi++];
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
  $('dlTiles').textContent = '地図と航空写真をダウンロード';
  toast(stopped ? 'ダウンロードを中断しました（続きから再開できます）' : '地図と航空写真のダウンロードが終わりました', 4000);
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
  const nz = (z) => countTiles(a, z), zopt = (z, label, cur, mb) => `<option value="${z}" ${cur === z ? 'selected' : ''}>${label}（約${nz(z).toLocaleString()}枚・約${Math.round(nz(z) * mb)}MB）</option>`;
  let tileCount = '…', usage = '';
  const el = $('pane-settings');
  el.innerHTML = `
    <div class="version">この版：<b>${APP_VERSION}</b></div>
    <button id="stUpdate" class="accent" style="width:100%;margin-top:8px">アップデートを確認する</button>
    <button id="stForce" style="width:100%;margin-top:6px;font-size:15px">うまく更新されないとき（読み込み直す）</button>
    <p class="small muted" style="margin:4px 0 0">どちらも、配達先・よく使う住所・地図・道路データは消えません。</p>
    <h3>地図の種類</h3>
    <p class="small muted">ふだんは見やすい「淡色地図」。地図の右上の「📷 写真」で、航空写真とすぐ切り替えられます。</p>
    <div class="btngrid"><button id="stPale" class="${st.mapSource === BASE_MAP ? 'primary' : ''}">🗺 淡色地図</button><button id="stPhoto" class="${st.mapSource === PHOTO_MAP ? 'primary' : ''}">📷 航空写真</button></div>
    <h3>オフライン準備</h3>
    <p class="small muted">家のWi-Fiなど、つながる所で一度行えば、電波がなくても地図とルート案内が使えます。</p>
    <div class="status-line">範囲：<b id="stArea">${esc(a.name || '指定した範囲')}</b></div>
    <div class="btngrid"><button id="stAreaShinko">信更町とその周辺</button><button id="stAreaPreset">長野市とその周辺</button><button id="stAreaView" style="grid-column:1/-1">今見ている範囲にする</button></div>
    <label>淡色地図の細かさ</label>
    <select id="stZoom">${zopt(15, 'ふつう', st.maxZoom, 0.012)}${zopt(16, '細かい', st.maxZoom, 0.012)}${zopt(17, 'とても細かい（家の形まで）', st.maxZoom, 0.012)}</select>
    <label>航空写真の細かさ</label>
    <select id="stPZoom">${zopt(16, 'ふつう', st.photoZoom, 0.035)}${zopt(17, '細かい（屋根が分かる）', st.photoZoom, 0.035)}${zopt(18, 'とても細かい（容量が大きい）', st.photoZoom, 0.035)}</select>
    <div class="status-line" style="margin-top:10px">① 保存済み：淡色地図 <b id="stTiles">…</b> 枚／航空写真 <b id="stPTiles">…</b> 枚</div>
    <button id="dlTiles" class="primary" style="width:100%">地図と航空写真をダウンロード</button>
    <div class="progress"><div id="dlBar"></div></div><div id="dlMsg" class="small muted"></div>
    <div class="status-line" style="margin-top:10px">② 道路データ（ルート計算用）：<b>${S.graphMeta ? new Date(S.graphMeta.created).toLocaleDateString('ja-JP') + ' 作成（' + S.graphMeta.nSeg.toLocaleString() + '区間）' : 'まだありません'}</b></div>
    <button id="rdBuild" class="primary" style="width:100%">${S.graphMeta ? '道路データを作り直す' : '道路データを作る'}</button>
    <div class="progress hidden" id="rdProg"><div id="rdBar"></div></div><div id="rdMsg" class="small muted"></div>
    <div class="status-line" id="stUsage"></div>
    <label style="display:flex;gap:10px;align-items:center;color:var(--text)"><input type="checkbox" id="stAuto" style="width:24px;height:24px" ${st.autoCache ? 'checked' : ''}> 見た地図も自動で保存する</label>
    <h3>地番から位置を推定（${CHIBAN ? Object.values(CHIBAN.aza).reduce((a, m) => a + m.size, 0).toLocaleString() + '筆' : '—'}）</h3>
    <p class="small muted">法務省の地図には、信更町の地番と土地の形が入っています。ただ地図上の位置が付いていないので、字ごとに<b>2〜3軒「位置を直す」で正しく合わせると</b>、その字の残りの地番の場所を推定できるようになります。</p>
    <div class="cb-list">${chibanStatusHtml()}</div>
    <h3>音声案内</h3>
    <div class="row"><button id="stVoice">${st.speech ? '🔊 音声あり' : '🔇 音声なし'}</button><button id="stVoiceTest">試しに話す</button></div>
    <h3>音声入力</h3>
    <p class="small muted">入力欄の横に🎤ボタンを出します。押して話すと文字になります。</p>
    <button id="stMic" style="width:100%">${st.voiceInput ? '🎤 音声入力ボタン：表示する' : '音声入力ボタン：表示しない'}</button>
    <h3>よく使う住所（${S.favorites.length}件）</h3>
    <button id="stFav" style="width:100%">よく使う住所を編集する</button>
    <h3>注意地点（${S.hazards.length}件）</h3>
    <p class="small muted">凍結しやすい所やチェーンを着けた所を登録すると、ナビ中に近づいたら知らせます。地図をタップしても追加できます。</p>
    <button id="stHz" style="width:100%">地図をタップして追加</button>
    <h3>動作確認</h3>
    <button id="stDemo" style="width:100%">デモ走行（GPSなしでナビを試す）</button>
    <h3>データの控え</h3>
    <p class="small muted">端末の中に、毎日自動で${SNAP_DAYS}日分の控えをとっています。端末が壊れたときのために、ときどき「ファイルに保存」もしてください。${st.lastFileBackup ? `（最後にファイルに保存した日：${st.lastFileBackup}）` : ''}</p>
    <div class="row"><button id="stSnap">毎日の控えから戻す</button></div>
    <div class="row"><button id="stFile" class="primary">ファイルに保存</button><button id="stFileIn">ファイルから戻す</button></div>
    <label style="display:flex;gap:10px;align-items:center;margin:6px 0"><input type="checkbox" id="stDaily" style="width:24px;height:24px" ${st.dailyFileBackup !== false ? 'checked' : ''}> 配達が全部終わったら、ファイルに保存するかたずねる</label>
    <div class="row"><button id="stExport">文字で控えを作る</button><button id="stImport">文字の控えから戻す</button></div>
    <h3>この地図について</h3>
    <p class="small muted">地図：国土地理院。道路データ：© OpenStreetMap contributors（ODbL）。住所データ：Geolonia 住所データ（CC BY 4.0、国土交通省 位置参照情報をもとに作成）。地番：法務省 登記所備付地図データ（G空間情報センター）を加工して作成。地図表示：Leaflet。<br>道路データは実際の通行規制と違うことがあります。必ず実際の道路標識に従ってください。</p>`;
  $('stUpdate').onclick = checkUpdate;
  $('stForce').onclick = forceReload;
  $('stPale').onclick = () => { st.mapSource = BASE_MAP; save(); setBaseLayer(); renderSettings(); };
  $('stPhoto').onclick = () => { st.mapSource = PHOTO_MAP; save(); setBaseLayer(); renderSettings(); };
  $('stPZoom').onchange = (e) => { st.photoZoom = +e.target.value; save(); };
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
  $('stSnap').onclick = snapshotsDialog;
  $('stFile').onclick = async () => { if (await saveBackupFile()) { toast('控えを保存しました'); renderSettings(); } };
  $('stFileIn').onclick = restoreFileDialog;
  $('stDaily').onchange = (e) => { st.dailyFileBackup = e.target.checked; save(); };
  $('stExport').onclick = exportDialog;
  $('stImport').onclick = importDialog;
  DB.count('tiles', DB.prefix(BASE_MAP + '/')).then((c) => { const t = $('stTiles'); if (t) t.textContent = c.toLocaleString(); });
  DB.count('tiles', DB.prefix(PHOTO_MAP + '/')).then((c) => { const t = $('stPTiles'); if (t) t.textContent = c.toLocaleString(); });
  if (navigator.storage && navigator.storage.estimate) navigator.storage.estimate().then((e) => { const u = $('stUsage'); if (u) u.innerHTML = `端末の使用量：<b>${Math.round(e.usage / 1048576)}MB</b>（使える目安 ${Math.round(e.quota / 1048576).toLocaleString()}MB）`; });
}
/* ---------- アップデート ---------- */
function waitActivated(sw, ms) {
  return new Promise((res) => {
    if (!sw || sw.state === 'activated') return res(true);
    const t = setTimeout(() => res(false), ms);
    sw.addEventListener('statechange', () => { if (sw.state === 'activated') { clearTimeout(t); res(true); } if (sw.state === 'redundant') { clearTimeout(t); res(false); } });
  });
}
async function checkUpdate() {
  if (S.nav) return toast('ナビ中は更新できません');
  if (!navigator.onLine) return toast('インターネットにつないでから押してください');
  const btn = $('stUpdate'); if (btn) { btn.disabled = true; btn.textContent = '確認しています…'; }
  try {
    const reg = navigator.serviceWorker && await navigator.serviceWorker.getRegistration();
    if (!reg) { location.reload(); return; }
    await reg.update();
    const nw = reg.installing || reg.waiting;
    if (nw) {
      if (btn) btn.textContent = '新しい版を取り込んでいます…';
      await waitActivated(nw, 30000);
      toast('新しい版に切り替えます'); setTimeout(() => location.reload(), 600);
    } else {
      toast('いまの版が最新です', 3500);
      if (btn) { btn.disabled = false; btn.textContent = 'アップデートを確認する'; }
    }
  } catch (e) {
    toast('確認できませんでした：' + e.message, 4000);
    if (btn) { btn.disabled = false; btn.textContent = 'アップデートを確認する'; }
  }
}
async function forceReload() {
  if (S.nav) return toast('ナビ中は更新できません');
  if (!navigator.onLine) return toast('インターネットにつないでから押してください');
  if (!(await ask('アプリの画面を読み込み直します。配達先や地図のデータは消えません。', '読み込み直す'))) return;
  try {
    const ks = await caches.keys(); await Promise.all(ks.map((k) => caches.delete(k)));
    const reg = navigator.serviceWorker && await navigator.serviceWorker.getRegistration();
    if (reg) await reg.unregister();
  } catch (e) { /* なし */ }
  location.reload();
}
function exportDialog() {
  const txt = JSON.stringify({ app: 'haitatsu-navi', v: 1, plans: S.plans, hazards: S.hazards, favorites: S.favorites, drawings: S.drawings, settings: S.settings });
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
        applyBackup(JSON.parse($('imTxt').value), '戻しました'); closeModal();
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
function renderAll() { renderPlan(); renderStops(); renderHazards(); renderDrawings(); setBaseLayer(); }

function layersDialog() {
  openModal(`<h2>地図の種類</h2>${[[BASE_MAP, MAP_SOURCES[BASE_MAP]], [PHOTO_MAP, MAP_SOURCES[PHOTO_MAP]], ['gsi_std', MAP_SOURCES.gsi_std]].map(([k, v]) => `<button data-src="${k}" class="${k === S.settings.mapSource ? 'primary' : ''}" style="width:100%;margin:4px 0">${esc(v.name)}</button>`).join('')}
    <button disabled style="width:100%;margin:4px 0">ゼンリン地図（契約後に追加）</button>
    <button id="lyDraw" style="width:100%;margin:8px 0 4px">${S.settings.showDrawings === false ? '✏️ 手書きを表示する' : '✏️ 手書きを隠す'}</button><p class="small muted">オフラインで使えるのは、ダウンロードした淡色地図と航空写真です（標準地図は見た分だけ）。</p>
    <div class="modal-btns"><button id="lyNo">閉じる</button></div>`, (box) => {
    $('lyNo').onclick = closeModal;
    $('lyDraw').onclick = () => { S.settings.showDrawings = S.settings.showDrawings === false; save(); renderDrawings(); closeModal(); };
    box.querySelectorAll('[data-src]').forEach((b) => { b.onclick = () => { S.settings.mapSource = b.dataset.src; save(); setBaseLayer(); closeModal(); }; });
  });
}

/* ---------- 起動 ---------- */
async function boot() {
  initMap();
  updateNet();
  try {
    const st = await DB.get('kv', 'state');
    if (st) { Object.assign(S.settings, st.settings || {}); S.plans = st.plans || []; S.planId = st.planId; S.hazards = st.hazards || []; S.favorites = st.favorites || []; S.drawings = st.drawings || [];
      if (!st.settings || !st.settings.v) { S.settings.v = 2; S.settings.area = Object.assign({}, PRESET_AREAS.shinko); S.settings.maxZoom = 17; if (S.settings.voiceInput === undefined) S.settings.voiceInput = true; }
      if (S.settings.v < 3) { S.settings.v = 3; if (S.settings.mapSource === 'gsi_std') S.settings.mapSource = BASE_MAP; if (!S.settings.photoZoom) S.settings.photoZoom = 17; } }
  } catch (e) { toast('この端末ではデータを保存できないようです'); }
  // 以前の版で住所の最後に付いた「付近」を消す
  const dropNear = (o) => { if (o && typeof o.address === 'string' && /付近$/.test(o.address)) o.address = o.address.replace(/付近$/, ''); };
  S.favorites.forEach(dropNear); S.plans.forEach((p) => p.stops.forEach(dropNear));
  if (!plan() && S.plans[0]) S.planId = S.plans[0].id;
  setBaseLayer();
  await loadAddr();
  loadChiban();
  autoSnapshot();
  renderPlan(); renderStops(); renderHazards(); renderDrawings();
  const p = plan();
  if (p && p.stops.length) map.fitBounds(L.latLngBounds(p.stops.map((s) => [s.lat, s.lng])), { padding: [30, 30], maxZoom: 16 });
  call('load').then((m) => { S.graphMeta = m; if (!$('pane-settings').classList.contains('hidden')) renderSettings(); }).catch(() => {});

  document.querySelectorAll('.tabs button').forEach((b) => { b.onclick = () => showTab(b.dataset.tab); });
  $('sheetHandle').onclick = () => $('sheet').classList.toggle('collapsed');
  [$('sheetHandle'), document.querySelector('.tabs')].forEach((el) => swipe(el, () => $('sheet').classList.add('collapsed'), () => $('sheet').classList.remove('collapsed')));
  $('btnLocate').onclick = () => { S.locateOnce = true; startGeo(); if (S.pos) onPosition(S.pos); };
  $('btnLayers').onclick = layersDialog;
  $('btnDraw').onclick = startDraw;
  $('btnPhoto').onclick = togglePhoto;
  $('nvPhoto').onclick = togglePhoto;
  updatePhotoButtons(S.settings.mapSource);
  $('pickCancel').onclick = endPick;
  $('btnFollow').onclick = () => setFollow('auto');
  $('nvDone').onclick = () => navDone('done');
  $('nvAbsent').onclick = () => navDone('absent');
  $('nvRedeliver').onclick = () => navDone('redeliver');
  $('nvFix').onclick = navFixPosition;
  $('nvEnd').onclick = async () => { if (await ask('ナビを終了しますか？', '終了する')) endNav(); };
  $('nvVoice').onclick = () => { S.settings.speech = !S.settings.speech; save(); $('nvVoice').textContent = S.settings.speech ? '🔊' : '🔇'; if (S.settings.speech) speak('音声案内をオンにしました'); };
  $('nvExt').onclick = () => {
    const p2 = plan(), s = S.nav && p2.stops[S.nav.idx]; if (!s) return;
    if (!navigator.onLine) return toast('外部ナビはインターネット接続が必要です');
    openExternal(`https://www.google.com/maps/dir/?api=1&destination=${s.lat},${s.lng}&travelmode=driving`);
  };
  $('modal').onclick = (e) => { if (e.target === $('modal')) closeModal(); };

  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    const hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.register('sw.js').then((reg) => {
      reg.addEventListener('updatefound', () => {
        const nw = reg.installing; if (!nw) return;
        nw.addEventListener('statechange', () => {
          if (nw.state === 'activated' && hadController && !S.nav) {
            let bar = $('undoBar');
            if (!bar) { bar = document.createElement('div'); bar.id = 'undoBar'; document.body.appendChild(bar); }
            bar.innerHTML = '<span>新しい版を取り込みました</span><button>今すぐ切り替える</button>';
            bar.classList.remove('hidden');
            bar.querySelector('button').onclick = () => location.reload();
          }
        });
      });
      document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') reg.update().catch(() => {}); });
    }).catch(() => {});
  }
  if (DEMO) window.__S = S;
}
boot();
