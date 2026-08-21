import { tag, esc, num } from "../xml.js";
import { textWidth } from "../measure.js";

const FONT = 13, PADX = 14, RH = 38, VGAP = 12, COLGAP = 50, MARGIN = 16;

// 去掉形状包装取标签
const labelOf = (s) => {
  const m = s.match(/^[\w-]*\s*[[({]+(.+?)[\])}]+\s*$/);
  return (m ? m[1] : s).trim();
};

// 按缩进解析为树：节点 [label, depthChildren[], w]
const parse = (body) => {
  const lines = body.split("\n").slice(1).filter((l) => l.trim());
  const stack = []; // [indent, node]
  let root = null;
  for (const raw of lines) {
    const indent = raw.length - raw.trimStart().length,
      node = { label: labelOf(raw.trim()), kids: [] };
    while (stack.length && stack[stack.length - 1][0] >= indent) stack.pop();
    if (!stack.length) {
      if (!root) root = node;
      else root.kids.push(node);
    } else stack[stack.length - 1][1].kids.push(node);
    stack.push([indent, node]);
  }
  return root;
};

const render = (body) => {
  const root = parse(body);
  if (!root) return [120, 60, ""];

  // 第一遍：布局（LR），y 由叶子顺序决定
  let leafY = MARGIN, maxX = 0;
  const place = (n, depth) => {
    n.w = Math.max(60, textWidth(n.label, FONT)[0] + 2 * PADX);
    n.x = MARGIN + depth * 0; // 暂存 depth
    n.depth = depth;
    if (!n.kids.length) {
      n.y = leafY + RH / 2;
      leafY += RH + VGAP;
    } else {
      n.kids.forEach((k) => place(k, depth + 1));
      n.y = (n.kids[0].y + n.kids[n.kids.length - 1].y) / 2;
    }
  };
  place(root, 0);

  // depth → x（累加每层最大宽度）
  const colMax = [];
  const measure = (n) => { colMax[n.depth] = Math.max(colMax[n.depth] || 0, n.w); n.kids.forEach(measure); };
  measure(root);
  const colX = [];
  let acc = MARGIN;
  for (let d = 0; d < colMax.length; ++d) { colX[d] = acc; acc += colMax[d] + COLGAP; }
  const setX = (n) => { n.x = colX[n.depth]; maxX = Math.max(maxX, n.x + n.w); n.kids.forEach(setX); };
  setX(root);

  let out = "";
  const draw = (n) => {
    n.kids.forEach((k) => {
      out += tag("path", { d: "M" + num(n.x + n.w) + " " + num(n.y) + "C" + num(n.x + n.w + COLGAP / 2) + " " + num(n.y) + " " + num(k.x - COLGAP / 2) + " " + num(k.y) + " " + num(k.x) + " " + num(k.y), fill: "none", stroke: "var(--_line)", "stroke-width": 1.5 });
      draw(k);
    });
    out += tag("rect", { x: num(n.x), y: num(n.y - RH / 2), width: num(n.w), height: RH, rx: RH / 2, fill: "var(--_node-fill)", stroke: "var(--_node-stroke)", "stroke-width": 1.5 });
    out += tag("text", { x: num(n.x + n.w / 2), y: num(n.y + 4), "text-anchor": "middle", "font-size": FONT, fill: "var(--_text)" }, esc(n.label));
  };
  draw(root);

  return [num(maxX + MARGIN), num(leafY + MARGIN), out];
};

export default render;
