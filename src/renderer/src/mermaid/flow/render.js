import { tag, esc, num } from "../xml.js";
import parse from "./parse.js";
import layout from "./layout.js";
import size, { FONT, LINE_H } from "./size.js";
import {
  RECT, ROUND, STADIUM, SUBROUTINE, CYLINDER, CIRCLE, DIAMOND, HEXAGON,
  PARALLELOGRAM, PARALLELOGRAM_ALT, TRAPEZOID, TRAPEZOID_ALT, ASYMMETRIC,
} from "../const/SHAPE.js";

const PAD = 24; // 整图外边距
const FILL = "var(--_node-fill)",
  STROKE = "var(--_node-stroke)",
  TEXT = "var(--_text)";

const poly = (pts) => tag("polygon", { points: pts.map(([x, y]) => num(x) + "," + num(y)).join(" "), fill: FILL, stroke: STROKE, "stroke-width": 1.5 });

// 形状绘制
const shapeSvg = (shape, cx, cy, w, h) => {
  const x = cx - w / 2,
    y = cy - h / 2,
    box = (rx) => tag("rect", { x: num(x), y: num(y), width: num(w), height: num(h), rx, fill: FILL, stroke: STROKE, "stroke-width": 1.5 });
  switch (shape) {
    case ROUND:
      return box(8);
    case STADIUM:
      return box(num(h / 2));
    case CIRCLE:
      return tag("circle", { cx: num(cx), cy: num(cy), r: num(w / 2), fill: FILL, stroke: STROKE, "stroke-width": 1.5 });
    case SUBROUTINE:
      return box(0) + tag("line", { x1: num(x + 7), y1: num(y), x2: num(x + 7), y2: num(y + h), stroke: STROKE }) + tag("line", { x1: num(x + w - 7), y1: num(y), x2: num(x + w - 7), y2: num(y + h), stroke: STROKE });
    case CYLINDER: {
      const ry = 7;
      return (
        tag("path", { d: "M" + num(x) + " " + num(y + ry) + "A" + w / 2 + " " + ry + " 0 0 0 " + num(x + w) + " " + num(y + ry) + "L" + num(x + w) + " " + num(y + h - ry) + "A" + w / 2 + " " + ry + " 0 0 1 " + num(x) + " " + num(y + h - ry) + "Z", fill: FILL, stroke: STROKE, "stroke-width": 1.5 }) +
        tag("path", { d: "M" + num(x) + " " + num(y + ry) + "A" + w / 2 + " " + ry + " 0 0 0 " + num(x + w) + " " + num(y + ry), fill: "none", stroke: STROKE, "stroke-width": 1.5 })
      );
    }
    case DIAMOND:
      return poly([[cx, y], [x + w, cy], [cx, y + h], [x, cy]]);
    case HEXAGON: {
      const o = h / 2;
      return poly([[x + o, y], [x + w - o, y], [x + w, cy], [x + w - o, y + h], [x + o, y + h], [x, cy]]);
    }
    case PARALLELOGRAM: {
      const s = 16;
      return poly([[x + s, y], [x + w, y], [x + w - s, y + h], [x, y + h]]);
    }
    case PARALLELOGRAM_ALT: {
      const s = 16;
      return poly([[x, y], [x + w - s, y], [x + w, y + h], [x + s, y + h]]);
    }
    case TRAPEZOID: {
      const s = 16;
      return poly([[x + s, y], [x + w - s, y], [x + w, y + h], [x, y + h]]);
    }
    case TRAPEZOID_ALT: {
      const s = 16;
      return poly([[x, y], [x + w, y], [x + w - s, y + h], [x + s, y + h]]);
    }
    case ASYMMETRIC:
      return poly([[x + 8, y], [x + w, y], [x + w, y + h], [x + 8, y + h], [x, cy]]);
    default:
      return box(0);
  }
};

// 多行文本
const labelSvg = (cx, cy, label) => {
  const lines = ("" + label).split("\n"),
    y0 = cy - ((lines.length - 1) * LINE_H) / 2 + 5;
  let s = "";
  lines.forEach((ln, i) => (s += tag("text", { x: num(cx), y: num(y0 + i * LINE_H), "text-anchor": "middle", "font-size": FONT, fill: TEXT }, esc(ln))));
  return s;
};

// 矩形边界与中心连线的交点
const border = (cx, cy, w, h, tx, ty) => {
  const dx = tx - cx,
    dy = ty - cy;
  if (!dx && !dy) return [cx, cy];
  const t = 1 / Math.max(Math.abs(dx) / (w / 2 + 1), Math.abs(dy) / (h / 2 + 1));
  return [cx + dx * t, cy + dy * t];
};

// 箭头：kind 'arrow' 实心 / 'circle' / 'cross'
const arrowEnd = (px, py, ang, kind) => {
  if (kind === "circle") return tag("circle", { cx: num(px), cy: num(py), r: 4, fill: FILL, stroke: "var(--_arrow)" });
  if (kind === "cross") {
    const c = Math.cos(ang), s = Math.sin(ang), d = 5;
    return tag("line", { x1: num(px - d * c - d * s), y1: num(py - d * s + d * c), x2: num(px + d * c + d * s), y2: num(py + d * s - d * c), stroke: "var(--_arrow)", "stroke-width": 1.6 }) +
      tag("line", { x1: num(px - d * c + d * s), y1: num(py - d * s - d * c), x2: num(px + d * c - d * s), y2: num(py + d * s + d * c), stroke: "var(--_arrow)", "stroke-width": 1.6 });
  }
  const a1 = ang + Math.PI - 0.4,
    a2 = ang + Math.PI + 0.4,
    d = 11;
  return tag("path", { d: "M" + num(px) + " " + num(py) + "L" + num(px + d * Math.cos(a1)) + " " + num(py + d * Math.sin(a1)) + "L" + num(px + d * Math.cos(a2)) + " " + num(py + d * Math.sin(a2)) + "Z", fill: "var(--_arrow)" });
};

// 解析 conn 得到 [dashed, thick, startKind, endKind]
const connStyle = (conn) => {
  const dashed = conn.includes("."),
    thick = conn.includes("="),
    end = conn.endsWith(">") ? "arrow" : conn.endsWith("o") ? "circle" : conn.endsWith("x") ? "cross" : "",
    start = conn.startsWith("<") ? "arrow" : conn.startsWith("o") ? "circle" : conn.startsWith("x") ? "cross" : "";
  return [dashed, thick, start, end];
};

const render = (body) => {
  const [dir, nodes, edges, subs] = parse(body),
    sizes = new Map();
  for (const [id, n] of nodes) sizes.set(id, size(n[1], n[2]));
  const [pos, lw, lh] = layout(dir, sizes, edges);
  if (!nodes.size) return [40, 40, ""];

  let edge_svg = "",
    label_svg = "";
  for (const [a, b, conn, lbl] of edges) {
    const pa = pos.get(a),
      pb = pos.get(b);
    if (!pa || !pb) continue;
    const [dashed, thick, sk, ek] = connStyle(conn),
      [sx, sy] = border(pa[0], pa[1], pa[2], pa[3], pb[0], pb[1]),
      [ex, ey] = border(pb[0], pb[1], pb[2], pb[3], pa[0], pa[1]),
      ang = Math.atan2(ey - sy, ex - sx);
    // 端点回缩，给箭头留空间
    const back = (x, y, k, dir2) => (k === "arrow" ? [x - 9 * Math.cos(dir2), y - 9 * Math.sin(dir2)] : [x, y]),
      [lex, ley] = back(ex, ey, ek, ang),
      [lsx, lsy] = back(sx, sy, sk, ang + Math.PI);
    edge_svg += tag("line", { x1: num(lsx), y1: num(lsy), x2: num(lex), y2: num(ley), stroke: "var(--_line)", "stroke-width": thick ? 3 : 1.5, "stroke-dasharray": dashed ? "5 4" : null, fill: "none" });
    if (ek) edge_svg += arrowEnd(ex, ey, ang, ek);
    if (sk) edge_svg += arrowEnd(sx, sy, ang + Math.PI, sk);
    if (lbl) {
      const mx = (sx + ex) / 2,
        my = (sy + ey) / 2,
        tw = lbl.length * 7 + 8;
      label_svg += tag("rect", { x: num(mx - tw / 2), y: num(my - 10), width: num(tw), height: 18, fill: "var(--bg)", opacity: 0.9 });
      label_svg += tag("text", { x: num(mx), y: num(my + 4), "text-anchor": "middle", "font-size": 13, fill: "var(--_text-muted)" }, esc(lbl));
    }
  }

  // subgraph 包围框
  let sub_svg = "";
  for (const [, title, members] of subs) {
    const ps = members.map((id) => pos.get(id)).filter(Boolean);
    if (!ps.length) continue;
    const x0 = Math.min(...ps.map((p) => p[0] - p[2] / 2)) - 14,
      y0 = Math.min(...ps.map((p) => p[1] - p[3] / 2)) - 26,
      x1 = Math.max(...ps.map((p) => p[0] + p[2] / 2)) + 14,
      y1 = Math.max(...ps.map((p) => p[1] + p[3] / 2)) + 14;
    sub_svg += tag("rect", { x: num(x0), y: num(y0), width: num(x1 - x0), height: num(y1 - y0), rx: 4, fill: "var(--_group-hdr)", stroke: STROKE, "stroke-dasharray": "4 3" });
    sub_svg += tag("text", { x: num(x0 + 10), y: num(y0 + 17), "font-size": 13, "font-weight": 600, fill: "var(--_text-muted)" }, esc(title));
  }

  let node_svg = "";
  for (const [id, n] of nodes) {
    const p = pos.get(id);
    if (!p) continue;
    node_svg += shapeSvg(n[1], p[0], p[1], p[2], p[3]) + labelSvg(p[0], p[1], n[2]);
  }

  const W = lw + 2 * PAD,
    H = lh + 2 * PAD,
    g = '<g transform="translate(' + PAD + " " + PAD + ')">' + sub_svg + edge_svg + node_svg + label_svg + "</g>";
  return [num(W), num(H), g];
};

export default render;
