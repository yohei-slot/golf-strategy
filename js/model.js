// ショットデータの解析と着弾シミュレーション（DOM非依存）
// 内部単位はすべてメートル。座標はボール位置を原点とするローカル平面（x=東, y=北）。

export const YD = 0.9144;

export const DEFAULT_SETTINGS = {
  unit: 'yd',          // 表示単位
  importUnit: 'yd',    // CSV取込時の単位
  carryFactor: 1.0,    // 練習場ボール補正（実球/レンジボール）
  spreadFactor: 1.2,   // ブレ拡大率（マット→芝、実戦プレッシャー分）
  windHead: 0.014,     // 向かい風 1m/s あたりのキャリー減少率
  windTail: 0.010,     // 追い風 1m/s あたりのキャリー増加率
  windCross: 0.012,    // 横風 1m/s・キャリー1m あたりの横流れ(m)
  imagery: 'gsi',      // 航空写真: 'gsi' | 'esri'
  esriKey: '',         // ArcGIS Location Platform のAPIキー（任意）
  samples: 2000,
  halfLifeDays: 60,    // 直近重視: 何日前のデータで重みが半分になるか（0=無効）
  rangeElev: 230,      // 練習条件が分からないショット用: 練習場の標高(m)
  rangeTemp: 20,       // 同: 練習時の気温(℃)
  courseTemp: 20,      // ラウンド中の気温(℃)
  altitudePct: 4,      // 標高差1000mあたりのキャリー増加率(%)（約1.2%/1000ft）。気温にも同じ空気密度の関係を使う
  wedgeLofts: { GW: 48, SW: 52, LW: 56 },   // ウェッジはロフト角で表示する
  useEstimates: true,  // data/estimates.json の推定距離を使う
};

// 画面表示用の番手名（ウェッジはロフト角）
export function clubLabel(club, settings) {
  const loft = settings?.wedgeLofts?.[club];
  return loft ? `${loft}°` : club;
}

export const CLUB_ORDER = ['1W', '3W', '4W', '5W', '7W', '9W', '2U', '3U', '4U', '5U', '6U', '7U',
  '2I', '3I', '4I', '5I', '6I', '7I', '8I', '9I', 'PW', 'AW', 'GW', 'SW', 'LW'];

// 落下角（度）。高低差をキャリー補正に換算するのに使う
export function descentAngle(club) {
  if (club === '1W') return 38;
  if (/W$/.test(club)) return 42;
  if (/U$/.test(club)) return 45;
  const n = parseInt(club, 10);
  if (/I$/.test(club)) return n <= 5 ? 46 : n <= 7 ? 48 : 50;
  return 52; // ウェッジ類
}

// 実測の落下角があればそれを、なければ番手別の目安を使う
export function landingAngle(stat) {
  return stat.landingAngle ?? descentAngle(stat.club);
}

export function normalizeClub(raw) {
  let s = String(raw || '').trim().toUpperCase().replace(/\s+/g, ' ');
  if (!s) return null;
  if (/^(DR|DRIVER|ドライバー|1W)$/.test(s)) return '1W';
  if (/(PITCHING|^P$|^PW$|ピッチング)/.test(s)) return 'PW';
  if (/(SAND|^SW$|サンド)/.test(s)) return 'SW';
  if (/(GAP|^GW$)/.test(s)) return 'GW';
  if (/(APPROACH|^AW$|アプローチ)/.test(s)) return 'AW';
  if (/(LOB|^LW$)/.test(s)) return 'LW';
  const m = s.match(/(\d+)[\s-]*(?:番)?[\s-]*(W|WOOD|ウッド|U|UT|H|HY|HYBRID|ユーティリティ|I|IRON|アイアン)/);
  if (m) {
    const t = m[2];
    const kind = /^(W|WOOD|ウッド)$/.test(t) ? 'W' : /^(I|IRON|アイアン)$/.test(t) ? 'I' : 'U';
    return m[1] + kind;
  }
  if (/^\d+$/.test(s)) return s + 'I';
  return s;
}

// "12 L" / "8R" / "左5" / "-3.2" → 右を正とした数値
function parseSide(v) {
  const s = String(v ?? '').trim();
  if (!s) return 0;
  const num = parseFloat(s.replace(/[^\d.\-]/g, ''));
  if (!isFinite(num)) return 0;
  if (/[LＬ左]/i.test(s)) return -Math.abs(num);
  if (/[RＲ右]/i.test(s)) return Math.abs(num);
  return num;
}

function splitLine(line, delim) {
  const out = [];
  let cur = '', q = false;
  for (const ch of line) {
    if (ch === '"') q = !q;
    else if (ch === delim && !q) { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out.map((c) => c.trim());
}

// CSV/TSV → [{club, carry, side, landing}]（メートル。ランはライ次第でぶれるので扱わない）
export function parseShotsCsv(text, unit = 'yd') {
  const lines = String(text || '').split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) return [];
  const delim = lines[0].includes('\t') ? '\t' : lines[0].includes(';') ? ';' : ',';
  const head = splitLine(lines[0], delim);
  const find = (re) => head.findIndex((h) => re.test(h));
  let idx = {
    club: find(/club|クラブ|番手/i),
    carry: find(/carry|キャリー/i),
    side: find(/offline|side|lateral|deviation|左右|ブレ|横/i),
    landing: find(/landing|落下|着地/i),
    date: find(/date|日付/i),
  };
  let start = 1;
  if (idx.club < 0 || idx.carry < 0) {
    idx = { club: 0, carry: 1, side: 2, landing: 3 };
    start = isFinite(parseFloat(head[1])) ? 0 : 1;
  }
  const k = unit === 'm' ? 1 : YD;
  const shots = [];
  for (let i = start; i < lines.length; i++) {
    const c = splitLine(lines[i], delim);
    const club = normalizeClub(c[idx.club]);
    const carry = parseFloat(c[idx.carry]);
    if (!club || !isFinite(carry) || carry <= 0) continue;
    const landing = idx.landing >= 0 ? parseFloat(c[idx.landing]) : NaN;
    const at = idx.date >= 0 ? Date.parse(c[idx.date]) : NaN;
    shots.push({
      club,
      carry: carry * k,
      side: (idx.side >= 0 ? parseSide(c[idx.side]) : 0) * k,
      landing: isFinite(landing) && landing > 10 && landing < 80 ? landing : null,
      ...(isFinite(at) ? { at } : {}),   // 練習日（あれば）
    });
  }
  return shots;
}

const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;

// 重み付き統計（直近重視の重み w を使う）
const wsum = (w) => w.reduce((s, v) => s + v, 0);
const wmean = (a, w) => a.reduce((s, v, i) => s + v * w[i], 0) / wsum(w);
function wsd(a, w, m = wmean(a, w)) {
  const W = wsum(w), W2 = w.reduce((s, v) => s + v * v, 0);
  const denom = W - W2 / W;   // 信頼度重みの不偏推定
  return denom > 0 ? Math.sqrt(a.reduce((s, v, i) => s + w[i] * (v - m) ** 2, 0) / denom) : 0;
}
function wquantile(a, w, t) {
  const idx = a.map((_, i) => i).sort((i, j) => a[i] - a[j]);
  const W = wsum(w);
  let acc = 0;
  for (const i of idx) { acc += w[i]; if (acc >= t * W) return a[i]; }
  return a[idx[idx.length - 1]];
}
// 外れ値に引っ張られにくいばらつき（標準偏差と IQR/1.349 の小さい方）
function robustSd(a, w) {
  const iqr = (wquantile(a, w, 0.75) - wquantile(a, w, 0.25)) / 1.349;
  const s = wsd(a, w);
  return iqr > 0 ? Math.min(s, iqr) : s;
}

const DAY = 86400000;

/**
 * 番手ごとの統計
 * 直近重視: その番手の最新の練習日から halfLifeDays 日さかのぼるごとに重みを半分にする。
 * 日付の無いショットは最新扱い（重み1）。halfLifeDays=0 なら全ショット同じ重み。
 */
export function computeStats(shots, settings = DEFAULT_SETTINGS) {
  const by = {};
  for (const s of shots) (by[s.club] ||= []).push(s);
  const stats = {};
  const hl = settings.halfLifeDays;
  for (const [club, arr] of Object.entries(by)) {
    const latest = Math.max(0, ...arr.map((s) => s.at || 0));
    const w = arr.map((s) => (hl > 0 && s.at && latest ? 0.5 ** ((latest - s.at) / (hl * DAY)) : 1));
    // 練習時の空気条件の影響を除き、標準大気（海抜0m・15℃）での値に揃える
    const air = arr.map((s) => airCarryFactor(s.elev, s.temp, settings));
    const carries = arr.map((s, i) => s.carry / air[i]);
    const sides = arr.map((s, i) => s.side / air[i]);
    const cm = wmean(carries, w), sm = wmean(sides, w);
    const nEff = wsum(w) ** 2 / w.reduce((s, v) => s + v * v, 0);   // 実効球数
    // 少数データ時は経験的な最小ばらつきを下限にする
    const csd = Math.max(nEff >= 3 ? wsd(carries, w, cm) : 0, cm * 0.04);
    const ssd = Math.max(nEff >= 3 ? wsd(sides, w, sm) : 0, cm * 0.05);
    const li = arr.map((s, i) => i).filter((i) => arr[i].landing != null);
    // KDE のバンド幅（2次元の Silverman 則: h = σ × n^(-1/6)、n は実効球数）。
    // 球数が少ないうちはばらつきを推定できないので、経験的な最小幅を下限にする
    const hk = nEff ** (-1 / 6);
    const few = nEff < 5;
    // 重み付き抽出用の累積分布
    const W = wsum(w);
    let acc = 0;
    const cum = w.map((v) => (acc += v / W));
    stats[club] = {
      club, n: arr.length, nEff,
      carryMean: cm, carrySd: csd, sideMean: sm, sideSd: ssd,
      landingAngle: li.length ? wmean(li.map((i) => arr[i].landing), li.map((i) => w[i])) : null,   // 実測の落下角（度）
      updatedAt: latest || null,
      practiceAir: wmean(air, w),   // 練習時の平均的な空気補正倍率（表示用）
      shots: arr.map((s, i) => ({ carry: carries[i], side: sides[i], landing: s.landing ?? null })),
      cum,
      kdeCarryH: Math.max(arr.length >= 2 ? robustSd(carries, w) * hk : 0, cm * (few ? 0.04 : 0.015)),
      kdeSideH: Math.max(arr.length >= 2 ? robustSd(sides, w) * hk : 0, cm * (few ? 0.05 : 0.015)),
    };
  }
  return stats;
}

/**
 * 推定距離の適用（データが古い・少ない番手の一時的な代替）
 * estimates: { 番手: { between: [番手A, 番手B], t } } → 平均キャリーを A + (B − A) × t に合わせる。
 * ばらつきの形はその番手自身のショットを比率で伸縮して残す。
 */
export function applyEstimates(stats, estimates) {
  const out = { ...stats };
  for (const [club, spec] of Object.entries(estimates || {})) {
    const s = stats[club], a = stats[spec.between?.[0]], b = stats[spec.between?.[1]];
    if (!s || !a || !b || club.startsWith('_')) continue;
    const target = a.carryMean + (b.carryMean - a.carryMean) * spec.t;
    const r = target / s.carryMean;
    out[club] = {
      ...s,
      carryMean: target, carrySd: s.carrySd * r, sideMean: s.sideMean * r, sideSd: s.sideSd * r,
      kdeCarryH: s.kdeCarryH * r, kdeSideH: s.kdeSideH * r,
      shots: s.shots.map((x) => ({ ...x, carry: x.carry * r, side: x.side * r })),
      estimated: { from: spec.between, originalCarry: s.carryMean },
    };
  }
  return out;
}

// 重みに比例してショットを1球選ぶ
function pickShot(stat, r) {
  let lo = 0, hi = stat.cum.length - 1;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (stat.cum[mid] < r) lo = mid + 1; else hi = mid; }
  return stat.shots[lo];
}

// ---- 空気密度による補正（標高・気温） ----
const SCALE_HEIGHT = 8434;   // 大気のスケールハイト(m)
// 標準大気（海抜0m・15℃）に対する空気密度の比
export function airDensityRatio(elev, temp) {
  return Math.exp(-elev / SCALE_HEIGHT) * (288.15 / (273.15 + temp));
}
// 標準大気と比べたキャリー倍率（空気が薄いほど飛ぶ）。
// 係数は「同じ気温で標高が1000m上がると altitudePct % 伸びる」から逆算し、気温にも同じ関係を当てはめる
// （結果として気温10℃上昇で約+1.2%）
export function airCarryFactor(elev, temp, settings) {
  const k = settings.altitudePct / 100 / (1 - Math.exp(-1000 / SCALE_HEIGHT));
  return 1 + k * (1 - airDensityRatio(elev ?? settings.rangeElev, temp ?? settings.rangeTemp));
}

export function sortedClubs(stats) {
  return Object.keys(stats).sort((a, b) => {
    const ia = CLUB_ORDER.indexOf(a), ib = CLUB_ORDER.indexOf(b);
    if (ia < 0 && ib < 0) return stats[b].carryMean - stats[a].carryMean;
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });
}

// 再現性のある乱数（ドラッグ中に点群がチラつかないように固定シード）
function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function normalPair(rand) {
  const u = Math.max(rand(), 1e-12), v = rand();
  const r = Math.sqrt(-2 * Math.log(u));
  return [r * Math.cos(2 * Math.PI * v), r * Math.sin(2 * Math.PI * v)];
}

// 風（打球方向基準）→ 追い風成分(+)/右向き成分(+)
// fromRel: 風が吹いてくる方向。0=正面から（アゲ）, 90=右から, 180=背中から（フォロー）
export function windComponents(wind) {
  const r = (wind.fromRel * Math.PI) / 180;
  return { along: -Math.cos(r) * wind.speed, cross: -Math.sin(r) * wind.speed };
}

export function applyWindToCarry(carry, along, settings) {
  return carry * (1 + (along >= 0 ? settings.windTail : settings.windHead) * along);
}

/**
 * 着弾シミュレーション
 * @param stat     computeStats の1番手分
 * @param bearing  打ち出し方向（北から時計回り, rad）
 * @param elev     (x, y) → 標高(m) | null （原点からのローカル座標）
 *
 * カーネル密度推定: 実際のショットを1球ランダムに選び、小さな揺らぎ（バンド幅 h）を足す。
 * 分布の形を仮定しないので、片側に出るミスや大きなミスショットの頻度がそのまま反映される。
 */
export function simulate({ stat, bearing, wind, elev, settings, n }) {
  n = n || settings.samples;
  const rand = mulberry32(12345);
  const u = [Math.sin(bearing), Math.cos(bearing)];   // 前方
  const v = [Math.cos(bearing), -Math.sin(bearing)];  // 右方
  const { along, cross } = windComponents(wind);
  const toTan = (deg) => Math.tan((deg * Math.PI) / 180);
  const tanMean = toTan(landingAngle(stat));
  const h0 = elev ? elev(0, 0) : null;
  const sf = settings.spreadFactor;
  const scale = settings.carryFactor * airCarryFactor(h0, settings.courseTemp, settings);
  const pts = new Array(n);
  for (let i = 0; i < n; i++) {
    const [z1, z2] = normalPair(rand);
    const s = pickShot(stat, rand());
    let c = stat.carryMean + sf * (s.carry - stat.carryMean + stat.kdeCarryH * z1);
    let l = stat.sideMean + sf * (s.side - stat.sideMean + stat.kdeSideH * z2);
    // そのショット自身の落下角で高低差を換算
    const tanD = s.landing != null ? toTan(s.landing) : tanMean;
    c *= scale;
    l *= scale;
    const c0 = applyWindToCarry(c, along, settings);
    l += settings.windCross * c0 * cross;
    c = c0;
    // 高低差: 着弾点が高ければ手前に落ちる（落下角で換算）。2回反復で収束させる
    if (h0 != null) {
      const base = c;
      for (let k = 0; k < 2; k++) {
        const h = elev(u[0] * c + v[0] * l, u[1] * c + v[1] * l);
        if (h == null) break;
        c = Math.max(base * 0.5, base - (h - h0) / tanD);
      }
    }
    pts[i] = [u[0] * c + v[0] * l, u[1] * c + v[1] * l];
  }
  return pts;
}


// 打球方向基準での中心・前後幅・左右幅（p範囲）
export function summarize(pts, bearing, p = 0.8) {
  const u = [Math.sin(bearing), Math.cos(bearing)];
  const v = [Math.cos(bearing), -Math.sin(bearing)];
  const along = pts.map(([x, y]) => x * u[0] + y * u[1]).sort((a, b) => a - b);
  const side = pts.map(([x, y]) => x * v[0] + y * v[1]).sort((a, b) => a - b);
  const q = (arr, t) => arr[Math.min(arr.length - 1, Math.max(0, Math.round(t * (arr.length - 1))))];
  const lo = (1 - p) / 2, hi = 1 - lo;
  return {
    along: q(along, 0.5), side: q(side, 0.5),
    alongLo: q(along, lo), alongHi: q(along, hi),
    sideLo: q(side, lo), sideHi: q(side, hi),
  };
}

// 狙い点までの「実質距離」（高低差・風を平地無風のキャリーに換算）
export function playsLike(dist, dh, angle, wind, settings, altF = 1) {
  const tanD = Math.tan((angle * Math.PI) / 180);
  const flat = dist + dh / tanD;
  const { along } = windComponents(wind);
  const f = 1 + (along >= 0 ? settings.windTail : settings.windHead) * along;
  return flat / (f * altF);
}

// 実質距離に最も近い平均キャリーの番手（どの番手とも大きく離れていれば null）
export function recommendClub(stats, target, settings) {
  let best = null, bestErr = Infinity;
  for (const s of Object.values(stats)) {
    const err = Math.abs(s.carryMean * settings.carryFactor - target);
    if (err < bestErr) { bestErr = err; best = s.club; }
  }
  return bestErr <= Math.max(10, target * 0.12) ? best : null;
}
