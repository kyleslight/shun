import { tag, esc, num } from "../xml.js";
import { textWidth } from "../measure.js";
import parse, { E_MSG, E_NOTE, E_OPEN, E_ELSE, E_CLOSE, E_ACT, E_DEACT, E_AUTONUM, OVER, RIGHT, LEFT } from "./parse.js";

const FONT = 14,
  ACTOR_H = 38,
  ACTOR_PAD = 14,
  MIN_ACTOR_W = 64,
  TOP = 10,
  HEAD_GAP = 28, // 头部框到首事件
  MSG_H = 42,
  GAP = 48, // 相邻 lifeline 最小间距
  LINE_H = 18,
  NOTE_PAD = 8,
  SELF_W = 56,
  ACT_W = 10, // 激活条宽
  EDGE = 12, // block 框到最外 lifeline
  BLK_TOP = 34, // block 标签区高
  BLK_PAD = 10;

const line = (x1, y1, x2, y2, dashed, stroke) =>
  tag("line", {
    x1: num(x1), y1: num(y1), x2: num(x2), y2: num(y2),
    stroke: stroke || "var(--_line)", "stroke-width": 1.5,
    "stroke-dasharray": dashed ? "4 3" : null,
  });

const label = (x, y, text, anchor, fill, weight) =>
  tag("text", { x: num(x), y: num(y), "text-anchor": anchor, "font-size": FONT, fill: fill || "var(--_text)", "font-weight": weight || null }, esc(text));

// 箭头头部：kind 1 实心三角 / 2 叉 / 3 异步开口 / 0 无
const head = (ex, y, dir, kind) => {
  const d = 9 * dir;
  if (kind === 1) return tag("path", { d: "M" + num(ex) + " " + num(y) + "L" + num(ex - d) + " " + num(y - 4) + "L" + num(ex - d) + " " + num(y + 4) + "Z", fill: "var(--_arrow)" });
  if (kind === 2)
    return (
      line(ex - 5, y - 5, ex + 5, y + 5, false, "var(--_arrow)") +
      line(ex - 5, y + 5, ex + 5, y - 5, false, "var(--_arrow)")
    );
  if (kind === 3)
    return line(ex, y, ex - d, y - 4, false, "var(--_arrow)") + line(ex, y, ex - d, y + 4, false, "var(--_arrow)");
  return "";
};

const headKind = (arrow) =>
  arrow.endsWith(">>") ? 1 : arrow.endsWith(")") ? 3 : arrow.endsWith("x") ? 2 : 0;

const render = (body) => {
  const [actors, events] = parse(body),
    n = actors.length;
  if (!n) return [10, 10, ""];

  // 参与者框宽
  const aw = actors.map(([, lbl]) => Math.max(MIN_ACTOR_W, textWidth(lbl, FONT)[0] + 2 * ACTOR_PAD));

  // 统一列距 pitch
  let pitch = GAP;
  for (let i = 0; i < n - 1; ++i) pitch = Math.max(pitch, aw[i] / 2 + aw[i + 1] / 2 + GAP);
  for (const e of events) {
    if (e[0] === E_MSG && e[1] !== e[2]) pitch = Math.max(pitch, (textWidth(e[3], FONT)[0] + 24) / Math.abs(e[2] - e[1]));
    if (e[0] === E_NOTE && e[2] !== e[3]) pitch = Math.max(pitch, (textWidth(e[4], FONT)[0] + 2 * NOTE_PAD) / Math.abs(e[3] - e[2]));
  }

  const cx = actors.map((_, i) => aw[0] / 2 + EDGE + 10 + i * pitch),
    head_bottom = TOP + ACTOR_H;
  const LEFT_EDGE = cx[0] - aw[0] / 2 - EDGE,
    RIGHT_EDGE = cx[n - 1] + aw[n - 1] / 2 + EDGE;

  let y = head_bottom + HEAD_GAP,
    max_x = RIGHT_EDGE,
    auto_on = false,
    auto_n = 0,
    auto_step = 1;
  const frames = [], // block 背景框（最先画）
    acts = [], // 激活条
    front = [], // 消息/注释/标签
    active = actors.map(() => []), // 每个参与者的激活起点栈
    blk_stack = []; // [startY, depth, kind]

  // 当前激活偏移（用于箭头贴激活条边缘）
  const offX = (i, side) => (active[i].length ? (ACT_W / 2) * side : 0);

  for (const e of events) {
    const t = e[0];
    if (t === E_AUTONUM) {
      auto_on = e[1];
      if (e[1]) {
        auto_n = e[2];
        auto_step = e[3];
      }
      continue;
    }

    if (t === E_ACT) {
      active[e[1]].push(y);
      continue;
    }
    if (t === E_DEACT) {
      const s = active[e[1]].pop();
      if (s !== undefined) acts.push([e[1], s, y, active[e[1]].length]);
      continue;
    }

    if (t === E_OPEN) {
      const kind = e[1].toLowerCase(), depth = blk_stack.length;
      blk_stack.push([y, depth, kind]);
      if (kind !== "rect") front.push(label(LEFT_EDGE + (depth + 1) * 4 + 8, y + 16, (kind === "box" ? "" : kind.toUpperCase() + (e[2] ? "  " : "")) + (e[2] || ""), "start", "var(--_text-muted)", 600));
      y += kind === "rect" ? 10 : BLK_TOP;
      continue;
    }
    if (t === E_ELSE) {
      const depth = blk_stack.length;
      front.push(line(LEFT_EDGE + depth * 4, y, RIGHT_EDGE - depth * 4, y, true));
      front.push(label(LEFT_EDGE + depth * 4 + 8, y + 16, e[1], "start", "var(--_text-muted)", 600));
      y += BLK_TOP;
      continue;
    }
    if (t === E_CLOSE) {
      const [sy, depth, kind] = blk_stack.pop() || [y, 0, ""];
      y += BLK_PAD;
      frames.push(
        tag("rect", {
          x: num(LEFT_EDGE + depth * 4), y: num(sy),
          width: num(RIGHT_EDGE - LEFT_EDGE - depth * 8), height: num(y - sy),
          fill: kind === "rect" ? "var(--_group-hdr)" : "none", "fill-opacity": kind === "rect" ? 0.28 : null,
          stroke: "var(--_node-stroke)", "stroke-width": 1, rx: 2,
        }),
      );
      continue;
    }

    if (t === E_NOTE) {
      const [, place, a, b, text] = e,
        [tw, lines] = textWidth(text, FONT),
        h = lines * LINE_H + 2 * NOTE_PAD;
      let nx, nw;
      if (place === OVER) {
        const lo = Math.min(cx[a], cx[b]),
          hi = Math.max(cx[a], cx[b]);
        nw = Math.max(tw + 2 * NOTE_PAD, hi - lo + 40);
        nx = (lo + hi) / 2 - nw / 2;
      } else if (place === RIGHT) {
        nx = cx[a] + 12;
        nw = tw + 2 * NOTE_PAD;
      } else {
        nw = tw + 2 * NOTE_PAD;
        nx = cx[a] - 12 - nw;
      }
      front.push(tag("rect", { x: num(nx), y: num(y), width: num(nw), height: num(h), fill: "var(--_group-hdr)", stroke: "var(--_node-stroke)", rx: 2 }));
      text.split("\n").forEach((ln, k) => front.push(label(nx + nw / 2, y + NOTE_PAD + (k + 1) * LINE_H - 4, ln, "middle", "var(--_text-muted)")));
      max_x = Math.max(max_x, nx + nw);
      y += h + 12;
      continue;
    }

    if (t === E_MSG) {
      const [, from, to, raw, arrow] = e,
        dashed = arrow.includes("--"),
        kind = headKind(arrow);
      let msg = raw;
      if (auto_on) {
        msg = auto_n + " " + raw;
        auto_n += auto_step;
      }
      // 先处理激活（+ 激活目标）
      if (e[5]) active[to].push(y);

      if (from === to) {
        const x0 = cx[from] + offX(from, 1),
          loop = SELF_W;
        front.push(line(x0, y, x0 + loop, y, dashed));
        front.push(line(x0 + loop, y, x0 + loop, y + 18, dashed));
        front.push(line(x0 + loop, y + 18, x0 + 6, y + 18, dashed));
        front.push(head(x0 + 6, y + 18, -1, kind || 1));
        front.push(label(x0 + loop + 6, y + 4, msg, "start", "var(--_text)"));
        max_x = Math.max(max_x, x0 + loop + 8 + textWidth(msg, FONT)[0]);
        y += MSG_H + 8;
      } else {
        const dir = to > from ? 1 : -1,
          sx = cx[from] + offX(from, dir),
          ex = cx[to] - offX(to, dir) - (kind ? 0 : 0),
          ax = ex; // 箭头落点
        front.push(line(sx, y, ax, y, dashed));
        front.push(head(ax, y, dir, kind));
        front.push(label((sx + ex) / 2, y - 6, msg, "middle", "var(--_text)"));
        y += MSG_H;
      }

      // - 停用源
      if (e[6]) {
        const s = active[from].pop();
        if (s !== undefined) acts.push([from, s, y - MSG_H + 10, active[from].length]);
      }
      continue;
    }
  }

  const foot_top = y + 6,
    H = foot_top + ACTOR_H + TOP,
    W = max_x + EDGE;

  // 关闭仍未停用的激活条
  active.forEach((stack, i) => stack.forEach((s, k) => acts.push([i, s, foot_top, k])));

  // lifelines
  let lifelines = "";
  for (let i = 0; i < n; ++i) lifelines += line(cx[i], head_bottom, cx[i], foot_top, false, "var(--_text-faint)");

  // 激活条
  let act_svg = "";
  for (const [i, s, en, depth] of acts)
    act_svg += tag("rect", { x: num(cx[i] - ACT_W / 2 + depth * 3), y: num(s), width: ACT_W, height: num(Math.max(en - s, 6)), fill: "var(--_node-fill)", stroke: "var(--_node-stroke)" });

  // 参与者框（上 + 下）
  const actorBox = (yy) => {
    let s = "";
    for (let i = 0; i < n; ++i) {
      const x = cx[i] - aw[i] / 2;
      s += tag("rect", { x: num(x), y: num(yy), width: num(aw[i]), height: ACTOR_H, rx: 4, fill: "var(--_node-fill)", stroke: "var(--_node-stroke)" });
      s += label(cx[i], yy + ACTOR_H / 2 + 5, actors[i][1], "middle", "var(--_text)", 600);
    }
    return s;
  };

  return [num(W), num(H), frames.join("") + lifelines + act_svg + actorBox(TOP) + actorBox(foot_top) + front.join("")];
};

export default render;
