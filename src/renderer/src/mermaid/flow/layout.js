import { isHoriz, isRev } from "../const/DIR.js";

const HGAP = 52,
  VGAP = 72,
  MARGIN = 20;

// 只为排版移除自环和回边；渲染阶段仍保留全部边
const acyclic = (ids, edges) => {
  const valid = new Set(ids),
    out = new Map(ids.map((id) => [id, []])),
    kept = [];
  const reaches = (from, to) => {
    const seen = new Set(), stack = [from];
    while (stack.length) {
      const id = stack.pop();
      if (id === to) return true;
      if (seen.has(id)) continue;
      seen.add(id);
      stack.push(...out.get(id));
    }
    return false;
  };
  for (const e of edges) {
    const [a, b] = e;
    if (!valid.has(a) || !valid.has(b) || a === b || reaches(b, a)) continue;
    out.get(a).push(b);
    kept.push(e);
  }
  return kept;
};

// 中位数
const median = (arr) => {
  if (!arr.length) return -1;
  const s = arr.slice().sort((a, b) => a - b),
    m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

// 分层（最长路径，忽略回边避免死循环）
const rankize = (ids, edges) => {
  const rank = new Map(ids.map((id) => [id, 0])),
    out = new Map(ids.map((id) => [id, []]));
  for (const [a, b] of edges) if (rank.has(a) && rank.has(b) && a !== b) out.get(a).push(b);
  // 松弛，最多 ids.length 轮
  for (let it = 0; it < ids.length; ++it) {
    let changed = false;
    for (const [a, b] of edges) {
      if (!rank.has(a) || !rank.has(b) || a === b) continue;
      if (rank.get(b) < rank.get(a) + 1) {
        rank.set(b, rank.get(a) + 1);
        changed = true;
      }
    }
    if (!changed) break;
  }
  return rank;
};

// 减少交叉：barycenter 多轮扫描
const order = (layers, edges, ids) => {
  const radj = new Map(ids.map((id) => [id, []])), // 上层邻居
    dadj = new Map(ids.map((id) => [id, []])); // 下层邻居
  for (const [a, b] of edges) {
    if (!radj.has(a) || !radj.has(b)) continue;
    dadj.get(a).push(b);
    radj.get(b).push(a);
  }
  const sweep = (up) => {
    const range = up ? [...layers.keys()].sort((x, y) => x - y) : [...layers.keys()].sort((x, y) => y - x);
    for (const r of range) {
      const layer = layers.get(r),
        idxOf = (lr, id) => lr.indexOf(id);
      const key = new Map();
      for (const id of layer) {
        const neigh = up ? radj.get(id) : dadj.get(id),
          near = layers.get(up ? r - 1 : r + 1);
        if (!near) {
          key.set(id, layer.indexOf(id));
          continue;
        }
        const pos = neigh.map((nb) => idxOf(near, nb)).filter((p) => p >= 0);
        key.set(id, pos.length ? median(pos) : layer.indexOf(id));
      }
      layer.sort((a, b) => key.get(a) - key.get(b));
    }
  };
  for (let i = 0; i < 4; ++i) {
    sweep(true);
    sweep(false);
  }
};

// 主布局：sz 为 Map id->[w,h]（外部算好），返回 [pos(Map id->[cx,cy,w,h]), W, H]
const layout = (dir, sz, edges) => {
  const ids = [...sz.keys()];
  if (!ids.length) return [new Map(), 0, 0];

  const dag = acyclic(ids, edges),
    rank = rankize(ids, dag),
    layers = new Map();
  for (const id of ids) {
    const r = rank.get(id);
    if (!layers.has(r)) layers.set(r, []);
    layers.get(r).push(id);
  }
  order(layers, dag, ids);

  const horiz = isHoriz(dir),
    rev = isRev(dir),
    // 沿主轴(层方向)长度、交叉轴长度取自 size，按方向取 w/h
    along = (id) => (horiz ? sz.get(id)[0] : sz.get(id)[1]), // 层进方向占用
    cross = (id) => (horiz ? sz.get(id)[1] : sz.get(id)[0]); // 层内排布占用

  const rkeys = [...layers.keys()].sort((a, b) => a - b),
    pos = new Map();

  // 主轴：逐层累加，层厚=层内 along 最大
  let main = MARGIN,
    cross_max = 0;
  const main_of = new Map();
  for (const r of rkeys) {
    const layer = layers.get(r),
      thick = Math.max(...layer.map(along));
    main_of.set(r, main + thick / 2);
    main += thick + VGAP;
    // 交叉轴排布
    let c = MARGIN;
    const place = new Map();
    for (const id of layer) {
      place.set(id, c + cross(id) / 2);
      c += cross(id) + HGAP;
    }
    cross_max = Math.max(cross_max, c - HGAP);
    layers.set(r + "_place", place); // 暂存
  }
  const main_total = main - VGAP + MARGIN;

  // 居中每层
  for (const r of rkeys) {
    const layer = layers.get(r),
      place = layers.get(r + "_place"),
      width = Math.max(...layer.map((id) => place.get(id) + cross(id) / 2)) - MARGIN,
      off = (cross_max - width) / 2;
    for (const id of layer) {
      const [w, h] = sz.get(id),
        cmain = main_of.get(r),
        ccross = place.get(id) + off;
      let cx, cy;
      if (horiz) {
        cx = cmain;
        cy = ccross;
      } else {
        cx = ccross;
        cy = cmain;
      }
      pos.set(id, [cx, cy, w, h]);
    }
  }

  let W = horiz ? main_total : cross_max + MARGIN,
    H = horiz ? cross_max + MARGIN : main_total;

  // 反向：BT/RL 翻转主轴
  if (rev)
    for (const [id, p] of pos) {
      if (horiz) p[0] = W - p[0];
      else p[1] = H - p[1];
    }

  return [pos, W, H];
};

export default layout;
