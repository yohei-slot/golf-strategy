import * as M from './model.js';
import * as G from './geo.js';
import { Dem, demUrl } from './dem.js';
import * as S from './store.js';
import { hdrContours } from './contour.js';

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

// コース（設定で切替。切り替えると再読み込み）
const courseList = await fetch('courses/index.json').then((r) => r.json());
const courseId = courseList.some((c) => c.id === S.load('courseId')) ? S.load('courseId') : courseList[0].id;
const course = await fetch(`courses/${courseId}.json`).then((r) => r.json());
// 同梱のショットデータ（data/shots.csv）。無ければ架空のサンプル
const bundledCsv = await fetch('data/shots.csv').then((r) => (r.ok ? r.text() : null)).catch(() => null);
const baseShots = M.parseShotsCsv(bundledCsv ?? await fetch('sample/shots_sample.csv').then((r) => r.text()), 'yd');
const baseIsSample = !bundledCsv;
// 一時的な推定距離（データの古い番手を他の番手から補間）
const estimates = await fetch('data/estimates.json').then((r) => (r.ok ? r.json() : {})).catch(() => ({}));
// 練習日ごとの条件（練習場の標高・気温）。ショットの日付で紐づける
const sessions = await fetch('data/sessions.json').then((r) => (r.ok ? r.json() : {})).catch(() => ({}));
const withConditions = (s) => {
  const ses = s.at ? sessions[new Date(s.at).toISOString().slice(0, 10)] : null;
  return ses ? { ...s, elev: ses.elev, temp: ses.temp } : s;
};

// ---------- 状態 ----------
let settings = { ...M.DEFAULT_SETTINGS, ...S.load('settings', {}) };
let shotData = S.load('shotdata', null); // { shots: [{club, carry, side, landing, at}], updatedAt }
let stats = {};
let clubs = [];
let holes = { ...course.holes, ...S.load(`holes.${course.id}`, {}) };

// 打つ位置などの画面状態はコースごとに保存（旧形式 'ui' は木曽駒のものとして引き継ぐ）
const uiKey = `ui.${course.id}`;
const ui = S.load(uiKey, course.id === 'kisokoma' ? S.load('ui', {}) : {});
const state = {
  hole: ui.hole ?? '',
  ball: ui.ball || course.center,
  aimBase: ui.aim || G.destination(course.center, 0, 130),
  dirOffset: 0,
  club: ui.club || null,
  tapMode: 'aim',
  wind: ui.wind || { speed: 0, fromRel: 0 },
  editing: null, // { hole, step: 'tee' | 'green', tee }
  recClub: null,
  altF: 1,   // いまの打つ位置での標高補正倍率
  showDots: ui.showDots ?? true,
  showRings: ui.showRings ?? true,
  greenSel: ui.greenSel ?? 'A',   // 2グリーンのコースで使うグリーン
  gpsAcc: null,                   // 直近のGPS測位 { center, radius }
};

const twoGreens = course.greens === 2;
// いま使うグリーン（2グリーンのコースで B を選んでいて、そのホールに B が登録されていれば B）
const greenOf = (h) => (twoGreens && state.greenSel === 'B' && h.green2 ? h.green2 : h.green);

function rebuildStats() {
  // 端末で取り込んだ番手は同梱データより優先
  const local = shotData?.shots || [];
  const localClubs = new Set(local.map((s) => s.club));
  const shots = [...baseShots.filter((s) => !localClubs.has(s.club)), ...local].map(withConditions);
  stats = M.computeStats(shots, settings);
  if (settings.useEstimates) stats = M.applyEstimates(stats, estimates);
  clubs = M.sortedClubs(stats);
  if (!stats[state.club]) state.club = clubs.includes('7I') ? '7I' : clubs[0];
}
rebuildStats();

const fmtD = (m) => (settings.unit === 'yd' ? `${Math.round(m / M.YD)}y` : `${Math.round(m)}m`);
const lbl = (club) => M.clubLabel(club, settings);
const fmtPct = (r) => `${r >= 0 ? '+' : '−'}${Math.abs(r * 100).toFixed(1)}%`;
const fmtN = (m) => (settings.unit === 'yd' ? Math.round(m / M.YD) : Math.round(m));
const deg = (r) => (r * 180) / Math.PI;
const rad = (d) => (d * Math.PI) / 180;

function aimPoint() {
  const b = G.bearing(state.ball, state.aimBase) + rad(state.dirOffset);
  return G.destination(state.ball, b, G.distance(state.ball, state.aimBase));
}
// 方向微調整を狙い点に焼き込む（打つ位置を動かす前など）
function bakeAim() {
  state.aimBase = aimPoint();
  state.dirOffset = 0;
  $('#dir').value = 0;
  $('#dirOut').textContent = '0°';
}

let persistTimer;
function persist() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => S.save(uiKey, {
    hole: state.hole, ball: state.ball, aim: aimPoint(), club: state.club, wind: state.wind,
    showDots: state.showDots, showRings: state.showRings, greenSel: state.greenSel,
  }), 400);
}

function toast(msg, ms = 2500) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { t.hidden = true; }, ms);
}

// ---------- 地図 ----------
// 航空写真のタイルURL（{z}/{x}/{y} 置換前のテンプレート）
function imageryTemplate() {
  if (settings.imagery === 'esri') {
    return settings.esriKey
      ? `https://ibasemaps-api.arcgis.com/arcgis/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}?token=${encodeURIComponent(settings.esriKey)}`
      : 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';
  }
  return 'https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/{z}/{x}/{y}.jpg';
}
function imagerySource() {
  return {
    // tileSize 128 にして1段細かいズームのタイルを読ませる（高DPIスマホで鮮明に）。どちらもこの地域は z18 が上限
    type: 'raster', tileSize: 128, maxzoom: 18,
    attribution: settings.imagery === 'esri'
      ? 'Esri, Vantor, Earthstar Geographics'
      : '<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank">国土地理院</a>',
    tiles: [imageryTemplate()],
  };
}
function applyImagery() {
  if (!map.getSource('photo')) return;
  map.removeLayer('photo');
  map.removeSource('photo');
  map.addSource('photo', imagerySource());
  map.addLayer({ id: 'photo', type: 'raster', source: 'photo' }, map.getLayer('ell-fill') ? 'ell-fill' : undefined);
}
const map = new maplibregl.Map({
  container: 'map',
  style: {
    version: 8,
    sources: { photo: imagerySource() },
    layers: [{ id: 'photo', type: 'raster', source: 'photo' }],
  },
  center: state.ball,
  zoom: 16.5,
  minZoom: 12,
  maxZoom: 20,
  pitchWithRotate: false,
  touchPitch: false,
  attributionControl: { compact: true },
});
map.touchZoomRotate.enableRotation();

const dem = new Dem(() => scheduleRecompute());

const ballEl = Object.assign(document.createElement('div'), { className: 'mk-ball' });
const aimEl = Object.assign(document.createElement('div'), { className: 'mk-aim' });
const distEl = Object.assign(document.createElement('div'), { className: 'mk-dist' });
const ballMk = new maplibregl.Marker({ element: ballEl, draggable: true }).setLngLat(state.ball).addTo(map);
const aimMk = new maplibregl.Marker({ element: aimEl, draggable: true }).setLngLat(aimPoint()).addTo(map);
const distMk = new maplibregl.Marker({ element: distEl, anchor: 'bottom', offset: [0, -22] }).setLngLat(aimPoint()).addTo(map);

ballMk.on('dragstart', bakeAim);
ballMk.on('drag', () => { state.ball = ballMk.getLngLat().toArray(); clearGps(); scheduleRecompute(); });
ballMk.on('dragend', persist);
aimMk.on('drag', () => {
  state.aimBase = aimMk.getLngLat().toArray();
  state.dirOffset = 0;
  $('#dir').value = 0;
  $('#dirOut').textContent = '0°';
  scheduleRecompute();
});
aimMk.on('dragend', persist);

// 確率範囲の表示スタイル（凡例 #legend と同じ色を使う）
const LEVELS = [
  { p: 0.95, color: '#38bdf8', fill: 0.06 },
  { p: 0.8, color: '#f59e0b', fill: 0.12 },
  { p: 0.5, color: '#ef4444', fill: 0.22 },
];
const empty = { type: 'FeatureCollection', features: [] };
map.on('load', () => {
  for (const id of ['rings', 'gps', 'ell', 'dots', 'lines', 'center']) map.addSource(id, { type: 'geojson', data: empty });
  map.addLayer({ id: 'rings', type: 'line', source: 'rings',
    paint: { 'line-color': '#ffffff', 'line-width': ['case', ['get', 'major'], 1.6, 0.7], 'line-opacity': ['case', ['get', 'major'], 0.85, 0.45] } });
  map.addLayer({ id: 'gps-fill', type: 'fill', source: 'gps', paint: { 'fill-color': '#3b82f6', 'fill-opacity': 0.15 } });
  map.addLayer({ id: 'gps-line', type: 'line', source: 'gps', paint: { 'line-color': '#60a5fa', 'line-width': 1.5 } });
  map.addLayer({ id: 'ell-fill', type: 'fill', source: 'ell',
    paint: { 'fill-color': ['get', 'color'], 'fill-opacity': ['get', 'op'] } });
  map.addLayer({ id: 'dots', type: 'circle', source: 'dots',
    layout: { visibility: state.showDots ? 'visible' : 'none' },
    paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 15, 1.2, 19, 3], 'circle-color': '#ffffff', 'circle-opacity': 0.6 } });
  map.addLayer({ id: 'ell-line', type: 'line', source: 'ell', filter: ['!=', ['get', 'p'], 0.95],
    paint: { 'line-color': ['get', 'color'], 'line-width': 2.5 } });
  map.addLayer({ id: 'ell-line-95', type: 'line', source: 'ell', filter: ['==', ['get', 'p'], 0.95],
    paint: { 'line-color': ['get', 'color'], 'line-width': 2, 'line-dasharray': [2, 1.5] } });
  map.addLayer({ id: 'lines', type: 'line', source: 'lines',
    paint: { 'line-color': '#ffffff', 'line-width': 2, 'line-dasharray': [2, 2], 'line-opacity': 0.9 } });
  map.addLayer({ id: 'center', type: 'circle', source: 'center',
    paint: { 'circle-radius': 5, 'circle-color': '#111827', 'circle-stroke-color': '#fff', 'circle-stroke-width': 2 } });
  renderHoleMarkers();
  renderRings();
  if (state.hole && holes[state.hole] && !ui.ball) goHole(state.hole);
  scheduleRecompute();
});

map.on('click', (e) => {
  const p = e.lngLat.toArray();
  if (state.editing) return handleEditClick(p);
  if (state.tapMode === 'ball') {
    bakeAim();
    setBall(p);
  } else {
    state.aimBase = p;
    state.dirOffset = 0;
    $('#dir').value = 0;
    $('#dirOut').textContent = '0°';
  }
  scheduleRecompute();
  persist();
});

function setSheetPadding() {
  const h = $('#sheet').offsetHeight;
  document.documentElement.style.setProperty('--sheet-h', `${h}px`);
  return h;
}
new ResizeObserver(setSheetPadding).observe($('#sheet'));

// ---------- 計算と描画 ----------
let rafPending = false;
function scheduleRecompute() {
  if (rafPending) return;
  rafPending = true;
  requestAnimationFrame(() => { rafPending = false; recompute(); });
}

function recompute() {
  const stat = stats[state.club];
  const aim = aimPoint();
  aimMk.setLngLat(aim);
  distMk.setLngLat(aim);
  if (!stat || !map.getSource('ell')) return;

  const origin = state.ball;
  const brg = G.bearing(origin, aim);
  syncWind(brg);
  const h0 = dem.get(origin);
  const elev = h0 == null ? null : (x, y) => dem.get(G.toLngLat(origin, [x, y]));
  const pts = M.simulate({ stat, bearing: brg, wind: state.wind, elev, settings });

  const toLL = (xy) => G.toLngLat(origin, xy);
  // 確率範囲は点群の密度から作る（楕円を仮定しない）。格子を打球方向に揃えるため打球座標系で計算
  const u = [Math.sin(brg), Math.cos(brg)], v = [Math.cos(brg), -Math.sin(brg)];
  const shotFrame = pts.map(([x, y]) => [x * u[0] + y * u[1], x * v[0] + y * v[1]]);
  const fromShot = ([a, s]) => toLL([a * u[0] + s * v[0], a * u[1] + s * v[1]]);
  const cont = hdrContours(shotFrame, [0.5, 0.8, 0.95]);
  map.getSource('ell').setData({ type: 'FeatureCollection', features: LEVELS.flatMap(({ p, color, fill }) =>
    cont[p].map((ring) => ({ type: 'Feature', properties: { p, color, op: fill },
      geometry: { type: 'Polygon', coordinates: [ring.map(fromShot)] } }))) });
  const meanXY = pts.reduce((m, [x, y]) => [m[0] + x / pts.length, m[1] + y / pts.length], [0, 0]);
  map.getSource('dots').setData({ type: 'FeatureCollection',
    features: pts.slice(0, 700).map((xy) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: toLL(xy) } })) });
  map.getSource('lines').setData({ type: 'FeatureCollection', features: [
    { type: 'Feature', geometry: { type: 'LineString', coordinates: [origin, aim] } },
  ] });
  map.getSource('center').setData({ type: 'FeatureCollection', features: [
    { type: 'Feature', geometry: { type: 'Point', coordinates: toLL(meanXY) } },
  ] });

  // 数値情報
  const aimDist = G.distance(origin, aim);
  const hAim = dem.get(aim);
  const dh = h0 != null && hAim != null ? hAim - h0 : null;
  // 標高補正（いま打つ位置の標高と練習場の標高の差）
  state.altF = M.airCarryFactor(h0, settings.courseTemp, settings);
  const pl = M.playsLike(aimDist, dh ?? 0, M.landingAngle(stat), state.wind, settings, state.altF);
  state.recClub = M.recommendClub(stats, pl, settings);
  // ホールを開いた直後は、標高が取れた時点でおすすめ番手に合わせる（手で選んだら以後は触らない）
  if (state.autoClub && dh != null) {
    state.autoClub = false;
    if (state.recClub && state.recClub !== state.club) { state.club = state.recClub; scheduleRecompute(); }
  }
  const sm = M.summarize(pts, brg, 0.8);
  const side = (v) => (Math.abs(v) < 0.5 * M.YD ? '0' : `${v < 0 ? 'L' : 'R'}${fmtN(Math.abs(v))}`);
  const hDisp = dh == null ? '標高取得中' : `${dh >= 0 ? '↑' : '↓'}${Math.abs(dh).toFixed(1)}m`;
  const hole = holes[state.hole];
  const toGreen = hole ? G.distance(toLL(meanXY), greenOf(hole)) : null;

  distEl.textContent = fmtD(aimDist);
  $('#info').innerHTML = `
    <div><span class="big">${lbl(state.club)}</span>
      平均キャリー <b>${fmtD(stat.carryMean * settings.carryFactor * state.altF)}</b>
      <span class="sub">（${stat.estimated ? `<b>推定</b>: ${stat.estimated.from.map(lbl).join('・')}から補間` : `${stat.n}球`}・練習時比 ${fmtPct(state.altF / stat.practiceAir - 1)}）</span></div>
    <div>狙い <b>${fmtD(aimDist)}</b>・高低差 <b>${hDisp}</b>${state.wind.speed ? `・風 ${windLabel()}` : ''}
      → 実質 <span class="em">${fmtD(pl)}</span>　おすすめ <span class="em">${state.recClub ? lbl(state.recClub) : '—'}</span></div>
    <div>着弾中心 <b>${fmtD(sm.along)}</b> ${side(sm.side)}${toGreen != null ? `・グリーンまで残り <b>${fmtD(toGreen)}</b>` : ''}</div>
    <div class="sub">80%範囲 前後 ${fmtN(sm.alongLo)}–${fmtD(sm.alongHi)}・左右 ${side(sm.sideLo)}〜${side(sm.sideHi)}
      ／ 標高: ${dem.lastSource ?? '—'}${baseIsSample && !shotData ? ' ／ <b>サンプルデータ</b>' : ''}</div>`;
  renderClubs();
}

const nearest45 = (d) => ((Math.round(d / 45) * 45) % 360 + 360) % 360;
function windLabel() {
  const names = { 0: 'アゲ', 45: '右前から', 90: '右から', 135: '右後ろから', 180: 'フォロー', 225: '左後ろから', 270: '左から', 315: '左前から' };
  return `${names[nearest45(state.wind.fromRel)]}${state.wind.speed}m/s${state.wind.fromAbs != null ? '(予報)' : ''}`;
}
// 予報の風（方位が絶対値）は、打つ方向が変わるたびに打球方向基準の向きへ換算し直す
function syncWind(brg) {
  const w = state.wind;
  if (w.fromAbs == null) return;
  const rel = ((w.fromAbs - deg(brg)) % 360 + 360) % 360;
  if (Math.abs(rel - w.fromRel) > 0.5) { state.wind = { ...w, fromRel: rel }; renderWind(); }
}

// ---------- 番手 ----------
function renderClubs() {
  const box = $('#clubs');
  const html = clubs.map((c) => `<button class="chip${c === state.club ? ' on' : ''}${c === state.recClub ? ' rec' : ''}" data-c="${c}">
    <b>${lbl(c)}${stats[c].estimated ? '<sup>推</sup>' : ''}</b><small>${fmtN(stats[c].carryMean * settings.carryFactor * state.altF)}</small></button>`).join('');
  if (box.dataset.html !== html) {
    box.innerHTML = html;
    box.dataset.html = html;
  }
}
$('#clubs').addEventListener('click', (e) => {
  const b = e.target.closest('.chip');
  if (!b) return;
  state.club = b.dataset.c;
  state.autoClub = false;
  scheduleRecompute();
  persist();
});

// ---------- 操作パネル ----------
$('#dir').addEventListener('input', (e) => {
  state.dirOffset = parseFloat(e.target.value);
  $('#dirOut').textContent = `${state.dirOffset > 0 ? 'R' : state.dirOffset < 0 ? 'L' : ''}${Math.abs(state.dirOffset)}°`;
  scheduleRecompute();
});
$('#dir').addEventListener('change', persist);
$$('.nudge').forEach((b) => b.addEventListener('click', () => {
  const r = $('#dir');
  r.value = Math.max(+r.min, Math.min(+r.max, parseFloat(r.value) + parseFloat(b.dataset.d)));
  r.dispatchEvent(new Event('input'));
  persist();
}));

function bindSeg(id, key) {
  $(id).addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    state[key] = b.dataset.v;
    $$(`${id} button`).forEach((x) => x.classList.toggle('on', x === b));
    scheduleRecompute();
  });
}
bindSeg('#tapMode', 'tapMode');
// シミュレーション点群の表示切替
function renderDotsToggle() {
  $('#btnDots').classList.toggle('on', state.showDots);
  $('#btnDots').textContent = state.showDots ? '点群 表示' : '点群 非表示';
  $('#legendDots').hidden = !state.showDots;
  if (map.getLayer('dots')) map.setLayoutProperty('dots', 'visibility', state.showDots ? 'visible' : 'none');
}
$('#btnDots').addEventListener('click', () => {
  state.showDots = !state.showDots;
  renderDotsToggle();
  persist();
});
renderDotsToggle();

function renderWind() {
  const w = state.wind;
  $('#btnWind').textContent = `${w.speed ? `風 ${windLabel()}` : '風 なし'}・${settings.courseTemp}℃`;
  $('#btnWind').classList.toggle('on', !!w.speed);
  $('#windSpeed').value = w.speed;
  $('#windSpeedOut').textContent = `${w.speed} m/s`;
  $$('#compass button').forEach((b) => b.classList.toggle('on',
    b.dataset.a === 'off' ? !w.speed : !!w.speed && +b.dataset.a === nearest45(w.fromRel)));
}
$('#btnWind').addEventListener('click', () => { $('#windPanel').hidden = !$('#windPanel').hidden; });
$('#compass').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.dataset.a === 'off') state.wind = { ...state.wind, speed: 0 };
  else state.wind = { fromRel: +b.dataset.a, speed: state.wind.speed || 3 };   // 手入力は打球方向基準（予報の方位は解除）
  renderWind(); scheduleRecompute(); persist();
});
$('#btnWindNow').addEventListener('click', async () => {
  try {
    const [lon, lat] = state.ball;
    const r = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${lat.toFixed(4)}&longitude=${lon.toFixed(4)}`
      + '&current=wind_speed_10m,wind_direction_10m,wind_gusts_10m&wind_speed_unit=ms');
    const c = (await r.json()).current;
    state.wind = { speed: Math.round(c.wind_speed_10m * 2) / 2, fromAbs: c.wind_direction_10m, fromRel: 0 };
    syncWind(G.bearing(state.ball, aimPoint()));
    renderWind(); scheduleRecompute(); persist();
    toast(`予報の風 ${c.wind_speed_10m}m/s（最大瞬間 ${c.wind_gusts_10m}m/s）を反映。地上10mの面的な予報なので、旗や木で確認を`, 5000);
  } catch {
    toast('風を取得できませんでした（圏外など）');
  }
});
$('#windSpeed').addEventListener('input', (e) => {
  state.wind = { ...state.wind, speed: parseFloat(e.target.value) };
  renderWind(); scheduleRecompute(); persist();
});
renderWind();

// ラウンド中の気温（空気密度の補正に使う）
function renderTemp() {
  $('#courseTemp').value = settings.courseTemp;
  renderWind();
}
$('#courseTemp').addEventListener('change', (e) => {
  const v = parseFloat(e.target.value);
  if (!Number.isFinite(v)) return;
  settings = { ...settings, courseTemp: v };
  S.save('settings', settings);
  renderTemp(); scheduleRecompute();
});
$('#btnTempNow').addEventListener('click', async () => {
  try {
    const [lon, lat] = state.ball;
    const r = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${lat.toFixed(4)}&longitude=${lon.toFixed(4)}&current=temperature_2m`);
    const t = (await r.json()).current.temperature_2m;
    settings = { ...settings, courseTemp: Math.round(t) };
    S.save('settings', settings);
    renderTemp(); scheduleRecompute();
    toast(`現在の気温 ${t}℃ を反映`);
  } catch {
    toast('気温を取得できませんでした（圏外など）');
  }
});
renderTemp();

// 狙い方向を画面上に
$('#btnUp').addEventListener('click', () => {
  // 打つ位置〜狙いの先（ばらつき分の余白）が収まるように、狙い方向を上にして表示
  const aim = aimPoint();
  const brg = G.bearing(state.ball, aim);
  const d = G.distance(state.ball, aim);
  const far = G.destination(state.ball, brg, d + 30);
  const sideL = G.destination(aim, brg - Math.PI / 2, 30), sideR = G.destination(aim, brg + Math.PI / 2, 30);
  const bounds = [state.ball, far, sideL, sideR].reduce((b, p) => b.extend(p), new maplibregl.LngLatBounds(state.ball, state.ball));
  const cam = map.cameraForBounds(bounds, { bearing: deg(brg), padding: { top: 70, bottom: setSheetPadding() + 20, left: 20, right: 20 }, maxZoom: 19 });
  map.easeTo({ ...cam, bearing: deg(brg) });
});

// GPS
function setBall(p) {
  state.ball = p;
  ballMk.setLngLat(p);
  clearGps();
}
function clearGps() {
  if (!state.gpsAcc) return;
  state.gpsAcc = null;
  map.getSource('gps')?.setData(empty);
}
function circlePolygon(center, r) {
  const ring = Array.from({ length: 49 }, (_, i) => G.destination(center, (i / 48) * 2 * Math.PI, r));
  return { type: 'Feature', geometry: { type: 'Polygon', coordinates: [ring] } };
}
// 最大8秒間測位を続け、誤差の小さい測位ほど重くして平均する（ばらつきは減るが、木や斜面による系統的なズレは残る）
$('#btnGps').addEventListener('click', () => {
  if (!navigator.geolocation) return toast('この端末では位置情報が使えません');
  const fixes = [];
  let done = false;
  let id = null;
  const finish = () => {
    if (done) return;
    done = true;
    if (id != null) navigator.geolocation.clearWatch(id);
    clearTimeout(timer);
    if (!fixes.length) return toast('位置情報を取得できませんでした');
    const use = fixes.slice(-10);
    const ws = use.map((f) => 1 / Math.max(1, f.acc) ** 2);
    const W = ws.reduce((a, b) => a + b, 0);
    const p = [use.reduce((t, f, i) => t + f.p[0] * ws[i], 0) / W, use.reduce((t, f, i) => t + f.p[1] * ws[i], 0) / W];
    const best = Math.min(...use.map((f) => f.acc));
    bakeAim();
    setBall(p);
    state.gpsAcc = { center: p, radius: best };
    map.getSource('gps')?.setData({ type: 'FeatureCollection', features: [circlePolygon(p, best)] });
    map.easeTo({ center: p });
    toast(`現在地を反映（${use.length}回平均・誤差 約${Math.round(best)}m）。青い円の中のどこかにいます`, 4000);
    scheduleRecompute(); persist();
  };
  const timer = setTimeout(finish, 8000);
  toast('測位中…（最大8秒）', 9000);
  id = navigator.geolocation.watchPosition((pos) => {
    fixes.push({ p: [pos.coords.longitude, pos.coords.latitude], acc: pos.coords.accuracy });
    toast(`測位中… ${fixes.length}回（誤差 約${Math.round(pos.coords.accuracy)}m）`, 9000);
    if (fixes.length >= 5 && pos.coords.accuracy <= 5) finish();
  }, (err) => {
    if (fixes.length) return;
    done = true;
    clearTimeout(timer);
    if (id != null) navigator.geolocation.clearWatch(id);
    toast(`位置情報を取得できません（${err.message}）`);
  }, { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 });
});

// ---------- 距離リング（グリーンからの残り距離） ----------
// カートナビや距離杭の表示と照らし合わせて、自分の位置を正確に置くための目盛り
const ringOffsetM = () => (settings.ringOffsetYd || 0) * M.YD;   // エッジ基準ならセンターまでの差を足す
let ringLabels = [];
function renderRings() {
  ringLabels.forEach((m) => m.remove());
  ringLabels = [];
  const src = map.getSource('rings');
  if (!src) return;
  const h = holes[state.hole];
  if (!state.showRings || !h) { src.setData(empty); return; }
  const g = greenOf(h);
  const step = settings.unit === 'yd' ? M.YD : 1;   // 表示単位で10刻み
  const brgLabel = G.bearing(g, h.tee) + 0.3;   // ティー方向から少し横にずらして、狙い線と重ならないようにする
  const features = [];
  for (let d = 30; d <= 300; d += 10) {
    const r = d * step + ringOffsetM();
    const major = d % 50 === 0;
    const ring = Array.from({ length: 97 }, (_, i) => G.destination(g, (i / 96) * 2 * Math.PI, r));
    features.push({ type: 'Feature', properties: { major }, geometry: { type: 'LineString', coordinates: ring } });
    if (major) {
      const el = Object.assign(document.createElement('div'), { className: 'mk-ring', textContent: `${d}` });
      ringLabels.push(new maplibregl.Marker({ element: el }).setLngLat(G.destination(g, brgLabel, r)).addTo(map));
    }
  }
  src.setData({ type: 'FeatureCollection', features });
}
function renderRingToggle() {
  $('#btnRings').classList.toggle('on', state.showRings);
  $('#btnRings').textContent = state.showRings ? 'リング 表示' : 'リング 非表示';
}
$('#btnRings').addEventListener('click', () => {
  state.showRings = !state.showRings;
  renderRingToggle(); renderRings(); persist();
});
renderRingToggle();
// カート・杭の残り距離で打つ位置を補正: いまの位置の「グリーンから見た方向」は保ち、距離だけ合わせる
$('#btnCalib').addEventListener('click', () => {
  const h = holes[state.hole];
  if (!h) return toast('ホールを選んでから使ってください');
  const g = greenOf(h);
  const ref = settings.ringOffsetYd ? 'エッジ' : 'センター';
  const unit = settings.unit === 'yd' ? 'y' : 'm';
  const k = settings.unit === 'yd' ? M.YD : 1;
  const cur = Math.round(Math.max(0, G.distance(g, state.ball) - ringOffsetM()) / k);
  const v = parseFloat(prompt(`カート・距離杭の表示（グリーン${ref}まで、${unit}）`, cur));
  if (!Number.isFinite(v) || v <= 0) return;
  bakeAim();
  setBall(G.destination(g, G.bearing(g, state.ball), v * k + ringOffsetM()));
  toast(`グリーン${ref}まで ${v}${unit} の位置に補正しました`);
  scheduleRecompute(); persist();
});

// ---------- ホール ----------
function renderHoleSelect() {
  const opts = [`<option value="">${course.short ?? ''} フリー</option>`];
  for (let i = 1; i <= course.holeCount; i++) {
    const inf = course.info?.[i];
    opts.push(`<option value="${i}">${i}番${inf ? ` P${inf.par} ${inf.yd}y` : ''}${holes[i] ? '' : '（未登録）'}</option>`);
  }
  $('#hole').innerHTML = opts.join('');
  $('#hole').value = state.hole;
}

let holeMarkers = [];
function renderHoleMarkers() {
  holeMarkers.forEach((m) => m.remove());
  holeMarkers = [];
  for (const [no, h] of Object.entries(holes)) {
    const active = greenOf(h);
    const g = Object.assign(document.createElement('div'), { className: 'mk-hole', textContent: no });
    const t = Object.assign(document.createElement('div'), { className: 'mk-tee' });
    holeMarkers.push(new maplibregl.Marker({ element: g }).setLngLat(active).addTo(map));
    holeMarkers.push(new maplibregl.Marker({ element: t }).setLngLat(h.tee).addTo(map));
    // 使っていない方のグリーンは小さく表示
    const other = active === h.green ? h.green2 : h.green;
    if (twoGreens && other) {
      const o = Object.assign(document.createElement('div'), { className: 'mk-hole2', textContent: active === h.green ? 'B' : 'A' });
      holeMarkers.push(new maplibregl.Marker({ element: o }).setLngLat(other).addTo(map));
    }
  }
}
function renderGreenToggle() {
  $('#btnGreen').hidden = !twoGreens;
  $('#btnGreen').textContent = `${state.greenSel}G`;
}
$('#btnGreen').addEventListener('click', () => {
  const h0 = holes[state.hole];
  const before = h0 ? greenOf(h0) : null;
  state.greenSel = state.greenSel === 'A' ? 'B' : 'A';
  // 狙いがグリーンに置かれていたら、切り替えた方のグリーンへ移す
  if (h0 && before && G.distance(aimPoint(), before) < 8) {
    state.aimBase = G.destination(state.ball, G.bearing(state.ball, greenOf(h0)), G.distance(state.ball, greenOf(h0)));
    state.dirOffset = 0;
    $('#dir').value = 0;
    $('#dirOut').textContent = '0°';
  }
  renderGreenToggle(); renderHoleMarkers(); renderRings();
  const h = holes[state.hole];
  if (h && !h.green2 && state.greenSel === 'B') toast(`${state.hole}番はBグリーン未登録のため Aグリーンを使います`);
  scheduleRecompute(); persist();
});
renderGreenToggle();

function goHole(no) {
  const h = holes[no];
  if (!h) return;
  const green = greenOf(h);
  const brg = G.bearing(h.tee, green);
  const len = G.distance(h.tee, green);
  setBall(h.tee);
  // ティーショットの狙い: グリーンが届く距離ならグリーン、そうでなければドライバー平均キャリー地点
  const altF = M.airCarryFactor(dem.get(h.tee), settings.courseTemp, settings);
  const longest = Math.max(...Object.values(stats).map((s) => s.carryMean * settings.carryFactor * altF));
  state.aimBase = len <= longest * 1.05 ? green : G.destination(h.tee, brg, longest);
  state.dirOffset = 0;
  $('#dir').value = 0;
  $('#dirOut').textContent = '0°';
  // 初期の番手は高低差込みの実質距離で選ぶ（標高が未取得なら平地扱い）
  const hTee = dem.get(h.tee), hAim = dem.get(state.aimBase);
  const dh = hTee != null && hAim != null ? hAim - hTee : 0;
  const pl = M.playsLike(G.distance(h.tee, state.aimBase), dh, 45, state.wind, settings, altF);
  state.club = M.recommendClub(stats, pl, settings) || state.club;
  state.autoClub = true;
  renderRings();
  const cam = map.cameraForBounds([h.tee, green].reduce((b, p) => b.extend(p), new maplibregl.LngLatBounds(h.tee, h.tee)),
    { bearing: deg(brg), padding: { top: 70, bottom: setSheetPadding() + 20, left: 40, right: 40 }, maxZoom: 18.5 });
  map.easeTo({ ...cam, bearing: deg(brg), duration: 600 });
  scheduleRecompute();
  persist();
}

function startEdit(no) {
  state.editing = { hole: no, step: 'tee' };
  $('#bannerText').textContent = `${no}番: ティーの位置をタップ`;
  $('#bannerSkip').hidden = true;
  $('#banner').hidden = false;
}
function endEdit() {
  state.editing = null;
  $('#banner').hidden = true;
}
function finishEdit(h) {
  const no = state.editing.hole;
  holes[no] = h;
  S.save(`holes.${course.id}`, holes);
  endEdit();
  renderHoleSelect();
  renderHoleMarkers();
  renderHoleStatus();
  const inf = course.info?.[no];
  const len = (g) => fmtD(G.distance(h.tee, g));
  toast(`${no}番を登録（${len(h.green)}${h.green2 ? `・B ${len(h.green2)}` : ''}${inf ? ` ／ 公式 ${inf.yd}y` : ''}）`, 4000);
  goHole(no);
}
function handleEditClick(p) {
  const ed = state.editing;
  if (ed.step === 'tee') {
    ed.tee = p;
    ed.step = 'green';
    $('#bannerText').textContent = `${ed.hole}番: ${twoGreens ? 'Aグリーン' : 'グリーン'}中心をタップ`;
    return;
  }
  if (ed.step === 'green' && twoGreens) {
    ed.green = p;
    ed.step = 'green2';
    $('#bannerText').textContent = `${ed.hole}番: Bグリーン中心をタップ`;
    $('#bannerSkip').hidden = false;
    return;
  }
  if (ed.step === 'green2') return finishEdit({ tee: ed.tee, green: ed.green, green2: p });
  finishEdit({ tee: ed.tee, green: p });
}
$('#bannerSkip').addEventListener('click', () => {
  const ed = state.editing;
  if (ed?.step === 'green2') finishEdit({ tee: ed.tee, green: ed.green });
});

$('#hole').addEventListener('change', (e) => {
  state.hole = e.target.value;
  endEdit();
  if (!state.hole) { persist(); return; }
  renderRings();
  if (holes[state.hole]) goHole(state.hole);
  else startEdit(state.hole);
});
$('#btnHoleEdit').addEventListener('click', () => {
  if (!state.hole) return toast('先にホールを選んでください');
  startEdit(state.hole);
});
$('#bannerCancel').addEventListener('click', endEdit);
renderHoleSelect();

// ---------- 設定ダイアログ ----------
const dlg = $('#settings');
$('#btnSettings').addEventListener('click', () => { fillSettings(); dlg.showModal(); });

const pctKeys = ['windHead', 'windTail'];
function fillSettings() {
  $('#courseSel').innerHTML = courseList.map((c) => `<option value="${c.id}">${c.name}</option>`).join('');
  $('#courseSel').value = course.id;
  $('#ringOffset').value = settings.ringOffsetYd ?? 0;
  $('#imagery').value = settings.imagery;
  $('#esriKey').value = settings.esriKey;
  $('#unit').value = settings.unit;
  for (const k of ['GW', 'SW', 'LW']) $(`#loft${k}`).value = settings.wedgeLofts?.[k] ?? '';
  $('#importUnit').value = settings.importUnit;
  $('#carryFactor').value = settings.carryFactor;
  $('#halfLifeDays').value = String(settings.halfLifeDays);
  $('#useEstimates').checked = settings.useEstimates;
  $('#estimateRow').hidden = !Object.keys(estimates).some((k) => !k.startsWith('_'));
  $('#rangeElev').value = settings.rangeElev;
  $('#rangeTemp').value = settings.rangeTemp;
  $('#altitudePct').value = settings.altitudePct;
  $('#spreadFactor').value = settings.spreadFactor;
  for (const k of pctKeys) $(`#${k}`).value = +(settings[k] * 100).toFixed(2);
  $('#windCross').value = +(settings.windCross * 100).toFixed(2);
  renderDataStatus();
  renderStatTable();
  renderHoleStatus();
}
function readSettings() {
  const num = (id, d) => { const v = parseFloat($(`#${id}`).value); return Number.isFinite(v) ? v : d; };
  const prevImagery = imageryTemplate();
  settings = {
    ...settings,
    imagery: $('#imagery').value,
    esriKey: $('#esriKey').value.trim(),
    unit: $('#unit').value,
    wedgeLofts: Object.fromEntries(['GW', 'SW', 'LW'].map((k) => [k, parseFloat($(`#loft${k}`).value)]).filter(([, v]) => v > 0)),
    importUnit: $('#importUnit').value,
    carryFactor: num('carryFactor', 1),
    halfLifeDays: num('halfLifeDays', 60),
    useEstimates: $('#useEstimates').checked,
    rangeElev: num('rangeElev', 230),
    rangeTemp: num('rangeTemp', 20),
    altitudePct: num('altitudePct', 4),
    spreadFactor: num('spreadFactor', 1.2),
    windHead: num('windHead', 1.4) / 100,
    windTail: num('windTail', 1.0) / 100,
    windCross: num('windCross', 1.2) / 100,
    ringOffsetYd: num('ringOffset', 0),
  };
  S.save('settings', settings);
  if (imageryTemplate() !== prevImagery) applyImagery();
  rebuildStats();
  renderStatTable();
  renderRings();
  scheduleRecompute();
}
$('#courseSel').addEventListener('change', (e) => {
  S.save('courseId', e.target.value);
  location.reload();
});
dlg.querySelectorAll('input[type=number], input#esriKey, input#useEstimates, select:not(#courseSel)').forEach((el) => el.addEventListener('change', readSettings));

function renderDataStatus() {
  const n = Object.values(stats).reduce((s, v) => s + v.n, 0);
  const el = $('#dataStatus');
  const base = baseIsSample ? 'サンプル（架空データ）' : '同梱データ';
  el.textContent = `${n}球・${clubs.length}番手：${base}${shotData ? ` ＋ 端末で取込 ${shotData.shots.length}球（最終 ${fmtDate(shotData.updatedAt)}）` : ''}`;
  el.classList.toggle('warn', baseIsSample && !shotData);
}
const fmtDate = (t) => (t ? new Date(t).toLocaleDateString('ja-JP', { month: 'numeric', day: 'numeric' }) : '—');
function renderStatTable() {
  const u = settings.unit === 'yd' ? 'y' : 'm';
  const rows = clubs.map((c) => {
    const s = stats[c];
    const f = settings.carryFactor;
    const pf = f * s.practiceAir;   // 練習時の条件に戻して表示
    return `<tr><td>${lbl(c)}${s.estimated ? `<small>（推定・元${fmtN(s.estimated.originalCarry * pf)}）</small>` : ''}</td><td>${s.n}</td><td>${fmtN(s.carryMean * pf)}</td><td>±${fmtN(s.carrySd * pf)}</td>
      <td>${s.sideMean >= 0 ? 'R' : 'L'}${fmtN(Math.abs(s.sideMean))}</td><td>±${fmtN(s.sideSd * f)}</td><td>${Math.round(M.landingAngle(s))}°${s.landingAngle == null ? '*' : ''}</td><td>${fmtDate(s.updatedAt)}</td></tr>`;
  }).join('');
  $('#statTable').innerHTML = `<thead><tr><th>番手</th><th>球数</th><th>キャリー(${u})※</th><th>前後σ</th><th>左右平均</th><th>左右σ</th><th>落下角</th><th>更新</th></tr></thead><tbody>${rows}</tbody>`;
}

function importCsv(text) {
  const shots = M.parseShotsCsv(text, settings.importUnit);
  if (!shots.length) return toast('有効なショットが見つかりませんでした');
  // 取り込んだ番手だけ置き換え、他の番手は残す
  const now = Date.now();
  const updated = [...new Set(shots.map((s) => s.club))];
  const kept = (shotData?.shots || []).filter((s) => !updated.includes(s.club));
  shotData = { shots: [...kept, ...shots.map((s) => ({ ...s, at: s.at ?? now }))], updatedAt: now };
  if (!S.save('shotdata', shotData)) toast('端末への保存に失敗しました（この画面を閉じると消えます）');
  rebuildStats();
  renderDataStatus(); renderStatTable(); scheduleRecompute();
  $('#csvText').value = '';
  toast(`${updated.map(lbl).join('・')} を更新（${shots.length}球）`);
}
$('#csvFile').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  if (f) importCsv(await f.text());
  e.target.value = '';
});
$('#btnImport').addEventListener('click', () => importCsv($('#csvText').value));
$('#btnPrompt').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(CLAUDE_PROMPT); toast('プロンプトをコピーしました'); } catch { toast('コピーできませんでした'); }
});

// TOPTRACERのスクショをClaudeアプリでCSV化するためのプロンプト
const CLAUDE_PROMPT = `添付はTOPTRACER Rangeアプリのショット一覧のスクリーンショットです（1番手につき横スクロール前後の2枚がある場合があります）。
画面上部のタイトルを番手名とし、各ショット行から FLAT CARRY・OFFLINE・LANDING ANGLE を読み取ってください。
- AVG行は除外
- 2枚に分かれている場合は SHOT # で行を突き合わせる
- 単位(yd, °)は付けない。OFFLINE は「L 14」「R 12」の形式のまま
- 読み取れない値は空欄
次の形式のCSVだけをコードブロックで出力してください（説明文は不要）:
club,carry,offline,landing
8-iron,145,L 14,47`;
$('#btnSample').addEventListener('click', () => {
  if (shotData && !confirm('この端末で取り込んだショットデータを削除しますか？（同梱データに戻ります）')) return;
  shotData = null;
  S.remove('shotdata');
  rebuildStats();
  renderDataStatus(); renderStatTable(); scheduleRecompute();
});

function renderHoleStatus() {
  const n = Object.keys(holes).length;
  $('#holeStatus').textContent = `${n} / ${course.holeCount} ホール登録済み`;
}
$('#btnHoleExport').addEventListener('click', async () => {
  const json = JSON.stringify(holes);
  $('#holeJson').value = json;
  try { await navigator.clipboard.writeText(json); toast('コピーしました'); } catch { toast('下の欄からコピーしてください'); }
});
$('#btnHoleImport').addEventListener('click', () => {
  try {
    const obj = JSON.parse($('#holeJson').value);
    holes = { ...holes, ...obj };
    S.save(`holes.${course.id}`, holes);
    renderHoleSelect(); renderHoleMarkers(); renderHoleStatus();
    toast('ホールを読み込みました');
  } catch {
    toast('JSONの形式が正しくありません');
  }
});

// ---------- オフライン ----------
$('#btnOffline').addEventListener('click', async () => {
  const st = $('#offlineStatus');
  if (!navigator.serviceWorker?.controller) {
    st.textContent = 'オフライン機能が有効になっていません（一度ページを再読み込みしてから再実行）';
    return;
  }
  const [w, s, e, n] = course.bbox;
  const pad = 0.003;
  const bbox = [w - pad, s - pad, e + pad, n + pad];
  const urls = [];
  for (let z = 14; z <= 18; z++) {
    for (const [, x, y] of G.tilesInBbox(bbox, z)) urls.push(imageryTemplate().replace('{z}', z).replace('{x}', x).replace('{y}', y));
  }
  for (const [src, z] of [['dem1a_png', 17], ['dem5a_png', 15], ['dem_png', 14]]) {
    for (const [, x, y] of G.tilesInBbox(bbox, z)) urls.push(demUrl(src, z, x, y));
  }
  let done = 0, failed = 0;
  const queue = [...urls];
  const worker = async () => {
    while (queue.length) {
      const u = queue.shift();
      try { const r = await fetch(u); if (!r.ok) failed++; } catch { failed++; }
      done++;
      st.textContent = `保存中… ${done} / ${urls.length}`;
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
  st.textContent = `保存完了: ${urls.length - failed} タイル${failed ? `（${failed}件失敗）` : ''}`;
});

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

// デバッグ・検証用
window.__golf = { state, stats, settings: () => settings, holes: () => holes, dem, map, recompute };
