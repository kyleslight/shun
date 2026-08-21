// 无 DOM 环境下的文本宽度估算（Inter 字体近似）。
// 用分档字符宽度表，比"字符数 × 固定系数"更准，足够布局用。

const NARROW = "ijl.,:;'|!ift()[]{} ",
  WIDE = "mwMW@%",
  // 相对 font-size 的宽度系数
  W_NARROW = 0.32,
  W_WIDE = 0.92,
  W_NORMAL = 0.56,
  W_UPPER = 0.68;

// 单行文本宽度（px）
const lineWidth = (s, size) => {
  let w = 0;
  for (const ch of s) {
    if (NARROW.includes(ch)) w += W_NARROW;
    else if (WIDE.includes(ch)) w += W_WIDE;
    else if (ch >= "A" && ch <= "Z") w += W_UPPER;
    else if (ch.charCodeAt(0) > 0x2e7f) w += 1; // CJK 等宽全角
    else w += W_NORMAL;
  }
  return w * size;
};

// 多行文本：返回 [最大宽度, 行数]
export const textWidth = (s, size) => {
  const lines = ("" + s).split("\n");
  let max = 0;
  for (const ln of lines) max = Math.max(max, lineWidth(ln, size));
  return [max, lines.length];
};

export default lineWidth;
