// SVG/XML 字符串拼接小工具，零依赖

const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" };

// 转义文本/属性值
export const esc = (s) => ("" + s).replace(/[&<>"]/g, (c) => ESC[c]);

// 把属性对象拼成 ` k="v"` 串，跳过 null/undefined
export const attr = (o) => {
  let out = "";
  for (const k in o) {
    const v = o[k];
    if (v !== null && v !== undefined && v !== false) out += " " + k + '="' + esc(v) + '"';
  }
  return out;
};

// 通用元素：tag(name, attrs, inner?)。inner 为 undefined 时自闭合
export const tag = (name, attrs, inner) =>
  inner === undefined
    ? "<" + name + attr(attrs) + "/>"
    : "<" + name + attr(attrs) + ">" + inner + "</" + name + ">";

// 数字保留 ≤2 位小数并去掉尾零，缩小体积
export const num = (n) => {
  const r = Math.round(n * 100) / 100;
  return r === Math.floor(r) ? "" + r : "" + r;
};
