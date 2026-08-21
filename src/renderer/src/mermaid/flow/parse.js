import {
  RECT, ROUND, STADIUM, SUBROUTINE, CYLINDER, CIRCLE, DIAMOND, HEXAGON,
  PARALLELOGRAM, PARALLELOGRAM_ALT, TRAPEZOID, TRAPEZOID_ALT, ASYMMETRIC, NAMED,
} from "../const/SHAPE.js";
import { dirOf } from "../const/DIR.js";

// 形状识别：opener 决定形状，非贪婪取标签。顺序：复合在前
const SHAPES = [
  [/^\(\[(.+?)\]\)/, STADIUM],
  [/^\[\[(.+?)\]\]/, SUBROUTINE],
  [/^\[\((.+?)\)\]/, CYLINDER],
  [/^\(\((.+?)\)\)/, CIRCLE],
  [/^\{\{(.+?)\}\}/, HEXAGON],
  [/^\[\/(.+?)\/\]/, PARALLELOGRAM],
  [/^\[\\(.+?)\\\]/, PARALLELOGRAM_ALT],
  [/^\[\/(.+?)\\\]/, TRAPEZOID],
  [/^\[\\(.+?)\/\]/, TRAPEZOID_ALT],
  [/^\[(.+?)\]/, RECT],
  [/^\((.+?)\)/, ROUND],
  [/^\{(.+?)\}/, DIAMOND],
  [/^>(.+?)\]/, ASYMMETRIC],
];

const ID = /^[A-Za-z0-9_.\-]+/;

const clean = (s) =>
  s.replace(/<br\s*\/?>/gi, "\n").replace(/^["'`]|["'`]$/g, "").replace(/&quot;/g, '"').trim();

// 解析单个节点：返回 [id, 长度, 形状或null, 标签或null]
const node = (s) => {
  const im = s.match(ID);
  if (!im) return null;
  const id = im[0];
  let rest = s.slice(id.length),
    shape = null,
    lbl = null;
  // 新版 @{ shape: x, label: "y" }
  const tm = rest.match(/^@\{(.+?)\}/);
  if (tm) {
    const inner = tm[1],
      sm = inner.match(/shape:\s*["']?([\w-]+)["']?/),
      lm = inner.match(/label:\s*"([^"]*)"/);
    shape = sm ? NAMED[sm[1]] ?? RECT : RECT;
    lbl = lm ? clean(lm[1]) : id;
    return [id, id.length + tm[0].length, shape, lbl];
  }
  for (const [re, sh] of SHAPES) {
    const m = rest.match(re);
    if (m) {
      shape = sh;
      lbl = clean(m[1]);
      return [id, id.length + m[0].length, shape, lbl];
    }
  }
  return [id, id.length, null, null];
};

// 解析节点组 A & B & ...，返回 [ids, 消耗长度]
const group = (s, nodes) => {
  const ids = [];
  let pos = 0;
  while (true) {
    const seg = s.slice(pos).replace(/^\s+/, ""),
      eaten = s.slice(pos).length - seg.length,
      nd = node(seg);
    if (!nd) break;
    const [id, len, shape, lbl] = nd;
    if (!nodes.has(id)) nodes.set(id, [id, RECT, id]);
    if (shape !== null) {
      const cur = nodes.get(id);
      cur[1] = shape;
      cur[2] = lbl;
    }
    ids.push(id);
    pos += eaten + len;
    const amp = s.slice(pos).match(/^\s*&\s*/);
    if (!amp) break;
    pos += amp[0].length;
  }
  return [ids, pos];
};

const CONN = /^\s*([<>ox=.\-]+)/;

// 解析连接符，返回 [conn, label, 消耗长度] 或 null
const edge = (s) => {
  const m = s.match(CONN);
  if (!m || !/[-.=]/.test(m[1])) return null;
  let conn = m[1],
    adv = m[0].length,
    lbl = "",
    after = s.slice(adv);
  // 中置文本形式 A -- text --> B
  if (!/[>]/.test(conn)) {
    const mm = after.match(/^\s*([^|\s][^|]*?)\s+([<>ox=.\-]+)\s*/);
    if (mm && /[-.=]/.test(mm[2])) {
      lbl = mm[1];
      conn += mm[2];
      adv += mm[0].length;
      after = s.slice(adv);
    }
  }
  const pm = after.match(/^\|([^|]*)\|\s*/);
  if (pm) {
    lbl = pm[1];
    adv += pm[0].length;
  }
  return [conn, clean(lbl), adv];
};

const parse = (body) => {
  const lines = body.split("\n"),
    head = lines[0].trim().match(/^(?:flowchart|graph)\s+(\w+)/),
    dir = dirOf(head ? head[1] : "TD"),
    nodes = new Map(), // id -> [id, shape, label]
    edges = [], // [from, to, conn, label]
    subs = [], // [id, title, allMembers[], directMembers[], parentId, direction]
    stack = []; // 当前 subgraph 成员收集

  // 外层保留所有后代，direct 仅保留直接节点，供嵌套布局使用
  const addMember = (id) => {
    for (const sg of stack) if (!sg[2].includes(id)) sg[2].push(id);
    const direct = stack.at(-1)?.[3];
    if (direct && !direct.includes(id)) direct.push(id);
  };

  for (let i = 1; i < lines.length; ++i) {
    let ln = lines[i].trim();
    if (!ln) continue;

    const sg = ln.match(/^subgraph\s*(.*)$/);
    if (sg) {
      const rest = sg[1].trim(),
        nm = rest.match(/^([A-Za-z0-9_.\-]+)?\s*(?:\[(.+?)\]|"(.+?)")?\s*$/),
        id = (nm && nm[1]) || "sub" + subs.length,
        title = (nm && (nm[2] || nm[3])) || id;
      const parent = stack.at(-1),
        entry = [id, clean(title), [], [], parent?.[0] || "", parent?.[5] ?? dir];
      subs.push(entry);
      stack.push(entry);
      continue;
    }
    if (/^end\b/.test(ln)) {
      stack.pop();
      continue;
    }
    const dm = ln.match(/^direction\s+(\w+)/);
    if (dm) {
      const current = stack.at(-1);
      if (current) current[5] = dirOf(dm[1]);
      continue;
    }
    // 忽略 style/classDef/class/click/linkStyle 等指令
    if (/^(style|classDef|class|click|linkStyle|class\s)/.test(ln)) continue;

    // 解析 节点组 (连接 节点组)*
    let pos = 0,
      prev = null;
    let guard = 0;
    while (pos < ln.length && guard++ < 200) {
      const [ids, glen] = group(ln.slice(pos), nodes);
      if (!ids.length) break;
      ids.forEach(addMember);
      pos += glen;
      if (prev) {
        const [conn, lbl] = prev;
        for (const a of prev[2]) for (const b of ids) edges.push([a, b, conn, lbl]);
      }
      const eg = edge(ln.slice(pos));
      if (!eg) break;
      prev = [eg[0], eg[1], ids];
      pos += eg[2];
    }
  }

  return [dir, nodes, edges, subs];
};

export default parse;
