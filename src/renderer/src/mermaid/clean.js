// 预处理：去掉 frontmatter、%% 注释、首尾空行；可选解析 init 配置里的 theme。
// 返回 [正文, config]，config.theme 为 frontmatter 指定的主题名（若有）。

const FRONT = /^\s*---\r?\n([\s\S]*?)\r?\n---\r?\n/;

// 极简从 frontmatter / init 指令里取 theme 名，避免引入 yaml 依赖
const themeOf = (s) => {
  const m = s.match(/theme:\s*["']?([\w-]+)["']?/);
  return m ? m[1] : null;
};

const clean = (text) => {
  let body = ("" + text).replace(/\r\n/g, "\n"),
    theme = null;
  const fm = body.match(FRONT);
  if (fm) {
    theme = themeOf(fm[1]);
    body = body.slice(fm[0].length);
  }
  // %%{init: ...}%% 指令里的主题
  const init = body.match(/%%\{[\s\S]*?\}%%/);
  if (init && !theme) theme = themeOf(init[0]);
  // 去掉整行 / 行尾 %% 注释（保留 %%{...}%% 指令之外的普通注释）
  body = body
    .split("\n")
    .map((ln) => (ln.trim().startsWith("%%") ? "" : ln))
    .join("\n")
    .trim();
  return [body, { theme }];
};

export default clean;
