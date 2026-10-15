// コース上のエリア（OB・池・バンカー・グリーン）と、着弾点の振り分け
import * as G from './geo.js';

export const AREA_TYPES = {
  ob: { label: 'OB', fill: '#ffffff', fillOpacity: 0.18, line: '#ef4444', text: '#dc2626' },
  water: { label: '池', fill: '#3b82f6', fillOpacity: 0.4, line: '#93c5fd', text: '#2563eb' },
  bunker: { label: 'バンカー', fill: '#fde68a', fillOpacity: 0.45, line: '#f59e0b', text: '#d97706' },
  green: { label: 'グリーン', fill: '#4ade80', fillOpacity: 0.3, line: '#bbf7d0', text: '#16a34a' },
};
// 重なっているときはこの順に優先（OBの中のバンカーなどは OB 扱い）
export const AREA_ORDER = ['ob', 'water', 'bunker', 'green'];

// 点が多角形の内側か（偶奇判定）
export function inside([x, y], ring) {
  let c = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}

const bboxOf = (ring) => ring.reduce((b, [x, y]) => [Math.min(b[0], x), Math.min(b[1], y), Math.max(b[2], x), Math.max(b[3], y)],
  [Infinity, Infinity, -Infinity, -Infinity]);

/**
 * 着弾点（原点基準のローカル座標）をエリア種別ごとに数える
 * @param targetGreen  グリーンとして数える多角形（選択中ホールのグリーン）。null なら全グリーン
 * @returns { counts: {ob, water, bunker, green, other}, n }
 */
export function classify(pts, origin, areas, targetGreen = null) {
  const polys = areas
    .filter((a) => a.type !== 'green' || !targetGreen || a === targetGreen)
    .map((a) => {
      const ring = a.ring.map((p) => G.toLocal(origin, p));
      return { type: a.type, ring, bb: bboxOf(ring), rank: AREA_ORDER.indexOf(a.type) };
    })
    .sort((a, b) => a.rank - b.rank);
  const counts = { ob: 0, water: 0, bunker: 0, green: 0, other: 0 };
  for (const p of pts) {
    let hit = 'other';
    for (const poly of polys) {
      const [x, y] = p, b = poly.bb;
      if (x < b[0] || x > b[2] || y < b[1] || y > b[3]) continue;
      if (inside(p, poly.ring)) { hit = poly.type; break; }
    }
    counts[hit]++;
  }
  return { counts, n: pts.length };
}

// 指定点を含むグリーンの多角形（選択中ホールのグリーンを特定する）
export function greenContaining(areas, lngLat) {
  return areas.find((a) => a.type === 'green' && inside(lngLat, a.ring)) ?? null;
}

// 打つ位置からグリーン中心へ向かう線と、グリーン多角形の交点 → 手前・奥のエッジまでの距離(m)
export function greenEdges(from, center, green) {
  const c = G.toLocal(from, center);
  const len = Math.hypot(c[0], c[1]);
  if (!len) return null;
  const u = [c[0] / len, c[1] / len];
  const ring = green.ring.map((p) => G.toLocal(from, p));
  const ts = [];
  for (let i = 0; i < ring.length - 1; i++) {
    const [ax, ay] = ring[i], [bx, by] = ring[i + 1];
    const ex = bx - ax, ey = by - ay;
    const den = u[0] * ey - u[1] * ex;
    if (Math.abs(den) < 1e-9) continue;
    const t = (ax * ey - ay * ex) / den;          // 線上の距離
    const s = (ax * u[1] - ay * u[0]) / den;      // 辺上の位置（0〜1）
    if (t > 0 && s >= 0 && s <= 1) ts.push(t);
  }
  if (ts.length < 2) return null;
  return { front: Math.min(...ts), back: Math.max(...ts) };
}
