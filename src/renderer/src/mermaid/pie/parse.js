// 解析 pie 图。返回 [title, rows, show_data]
//   title: 标题字符串（可空）
//   rows: [[label, value], ...]
//   show_data: 是否在图例显示数值
const DATA = /^\s*"([^"]*)"\s*:\s*([\d.]+)\s*$/;

const parse = (body) => {
  const lines = body.split("\n");
  let title = "",
    show_data = false;
  const rows = [];
  // 首行：pie [showData] [title ...]
  const head = lines[0].trim();
  const hm = head.match(/^pie\b(.*)$/);
  if (hm) {
    let rest = hm[1].trim();
    if (/^showData\b/.test(rest)) {
      show_data = true;
      rest = rest.replace(/^showData\b/, "").trim();
    }
    const tm = rest.match(/^title\s+(.+)$/);
    if (tm) title = tm[1].trim();
  }
  for (let i = 1; i < lines.length; ++i) {
    const ln = lines[i].trim();
    if (!ln) continue;
    const tm = ln.match(/^title\s+(.+)$/);
    if (tm) {
      title = tm[1].trim();
      continue;
    }
    const dm = lines[i].match(DATA);
    if (dm) rows.push([dm[1], parseFloat(dm[2])]);
  }
  return [title, rows, show_data];
};

export default parse;
