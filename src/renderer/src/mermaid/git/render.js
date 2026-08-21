import { tag, esc, num } from "../xml.js";

const COLW = 46, LANE_H = 54, PADX = 80, TOP = 30, R = 9;
const LANE_COLORS = ["#6c5ce7", "#00b894", "#e17055", "#0984e3", "#e84393", "#fdcb6e"];

const render = (body) => {
  const lines = body.split("\n").slice(1).map((l) => l.trim()).filter(Boolean);
  const lanes = new Map([["main", 0]]); // branch -> lane
  const tip = new Map([["main", [0, 0]]]); // branch -> [col, lane]
  let cur = "main", col = 0, maxCol = 0;
  const commits = [], edges = [];

  for (const ln of lines) {
    let m;
    if ((m = ln.match(/^branch\s+(\S+)/))) {
      const lane = lanes.size;
      lanes.set(m[1], lane);
      tip.set(m[1], tip.get(cur).slice());
      continue;
    }
    if ((m = ln.match(/^(?:checkout|switch)\s+(\S+)/))) { if (lanes.has(m[1])) cur = m[1]; continue; }
    if ((m = ln.match(/^merge\s+(\S+)/))) {
      const lane = lanes.get(cur), from = tip.get(m[1]);
      ++col;
      const c = [col, lane];
      if (from) edges.push([from, c]);
      edges.push([tip.get(cur), c]);
      commits.push([col, lane, true]);
      tip.set(cur, c);
      maxCol = Math.max(maxCol, col);
      continue;
    }
    if (/^commit\b/.test(ln)) {
      const lane = lanes.get(cur);
      ++col;
      const c = [col, lane];
      edges.push([tip.get(cur), c]);
      commits.push([col, lane, false]);
      tip.set(cur, c);
      maxCol = Math.max(maxCol, col);
      continue;
    }
  }

  const xy = (c) => [PADX + c[0] * COLW, TOP + c[1] * LANE_H + LANE_H / 2];
  const W = PADX + (maxCol + 1) * COLW + 20, H = TOP + lanes.size * LANE_H + 10;
  let out = "";
  // 分支标签 + 基线
  for (const [name, lane] of lanes) {
    const y = TOP + lane * LANE_H + LANE_H / 2;
    out += tag("text", { x: 12, y: num(y + 4), "font-size": 12, "font-weight": 600, fill: "var(--_text)" }, esc(name));
  }
  for (const [a, b] of edges) {
    const [x1, y1] = xy(a), [x2, y2] = xy(b);
    out += tag("path", { d: "M" + num(x1) + " " + num(y1) + "C" + num((x1 + x2) / 2) + " " + num(y1) + " " + num((x1 + x2) / 2) + " " + num(y2) + " " + num(x2) + " " + num(y2), fill: "none", stroke: "var(--_line)", "stroke-width": 2 });
  }
  for (const [c, lane, merge] of commits) {
    const [x, y] = xy([c, lane]), color = LANE_COLORS[lane % LANE_COLORS.length];
    out += tag("circle", { cx: num(x), cy: num(y), r: R, fill: merge ? "var(--bg)" : color, stroke: color, "stroke-width": 2.5 });
  }
  return [num(W), num(H), out];
};

export default render;
