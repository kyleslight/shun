// 解析 xychart-beta。返回 [title, x_cats, series, y_title, x_title, y_range]
//   x_cats: 分类标签数组（数值轴时为空）
//   series: [[kind, values[]], ...]  kind: 0 bar / 1 line
//   y_range: [min,max] 或 null
export const BAR = 0, LINE = 1;

const nums = (s) => (s.match(/-?[\d.]+/g) || []).map(Number);

// 解析 [a, b, "c d", ...] 为字符串数组
const arr = (s) => {
  const inner = s.replace(/^\[/, "").replace(/\]$/, "");
  const out = [];
  let m;
  const re = /"([^"]*)"|([^,]+)/g;
  while ((m = re.exec(inner))) out.push((m[1] != null ? m[1] : m[2]).trim());
  return out.filter((x) => x !== "");
};

const parse = (body) => {
  const lines = body.split("\n").slice(1);
  let title = "", x_title = "", y_title = "", x_cats = [], y_range = null;
  const series = [];

  for (const raw of lines) {
    const ln = raw.trim();
    if (!ln) continue;
    let m;
    if ((m = ln.match(/^title\s+"?([^"]+)"?/))) { title = m[1].trim(); continue; }
    if (/^x-axis/.test(ln)) {
      const tm = ln.match(/"([^"]*)"/);
      if (tm) x_title = tm[1];
      const br = ln.match(/\[(.*)\]/);
      if (br) x_cats = arr("[" + br[1] + "]");
      continue;
    }
    if (/^y-axis/.test(ln)) {
      const tm = ln.match(/"([^"]*)"/);
      if (tm) y_title = tm[1];
      const rg = ln.match(/(-?[\d.]+)\s*-->\s*(-?[\d.]+)/);
      if (rg) y_range = [+rg[1], +rg[2]];
      continue;
    }
    if (/^bar\b/.test(ln)) { series.push([BAR, nums(ln)]); continue; }
    if (/^line\b/.test(ln)) { series.push([LINE, nums(ln)]); continue; }
  }
  return [title, x_cats, series, y_title, x_title, y_range];
};

export default parse;
