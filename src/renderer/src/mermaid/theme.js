// 主题系统：移植自 beautiful-mermaid (MIT)，CSS 变量 + color-mix 派生。
// 两个必填变量 --bg/--fg，五个可选增强 --line/--accent/--muted/--surface/--border，
// 未设置的可选项由 color-mix 从 bg+fg 派生。换肤只改 inline 变量，无需重渲染。

// 15 个内置主题（与 beautiful-mermaid 一致）
export const THEMES = {
  "zinc-light": { bg: "#FFFFFF", fg: "#27272A" },
  "zinc-dark": { bg: "#18181B", fg: "#FAFAFA" },
  "tokyo-night": { bg: "#1a1b26", fg: "#a9b1d6", line: "#3d59a1", accent: "#7aa2f7", muted: "#565f89" },
  "tokyo-night-storm": { bg: "#24283b", fg: "#a9b1d6", line: "#3d59a1", accent: "#7aa2f7", muted: "#565f89" },
  "tokyo-night-light": { bg: "#d5d6db", fg: "#343b58", line: "#34548a", accent: "#34548a", muted: "#9699a3" },
  "catppuccin-mocha": { bg: "#1e1e2e", fg: "#cdd6f4", line: "#585b70", accent: "#cba6f7", muted: "#6c7086" },
  "catppuccin-latte": { bg: "#eff1f5", fg: "#4c4f69", line: "#9ca0b0", accent: "#8839ef", muted: "#9ca0b0" },
  nord: { bg: "#2e3440", fg: "#d8dee9", line: "#4c566a", accent: "#88c0d0", muted: "#616e88" },
  "nord-light": { bg: "#eceff4", fg: "#2e3440", line: "#aab1c0", accent: "#5e81ac", muted: "#7b88a1" },
  dracula: { bg: "#282a36", fg: "#f8f8f2", line: "#6272a4", accent: "#bd93f9", muted: "#6272a4" },
  "github-light": { bg: "#ffffff", fg: "#1f2328", line: "#d1d9e0", accent: "#0969da", muted: "#59636e" },
  "github-dark": { bg: "#0d1117", fg: "#e6edf3", line: "#3d444d", accent: "#4493f8", muted: "#9198a1" },
  "solarized-light": { bg: "#fdf6e3", fg: "#657b83", line: "#93a1a1", accent: "#268bd2", muted: "#93a1a1" },
  "solarized-dark": { bg: "#002b36", fg: "#839496", line: "#586e75", accent: "#268bd2", muted: "#586e75" },
  "one-dark": { bg: "#282c34", fg: "#abb2bf", line: "#4b5263", accent: "#c678dd", muted: "#5c6370" },
};

export const DEFAULT_THEME = "zinc-light";

// color-mix 派生权重（fg 混入 bg 的百分比）
const MIX = [
  ["--_text-sec", "--muted", 60],
  ["--_text-muted", "--muted", 40],
  ["--_text-faint", null, 25],
  ["--_line", "--line", 50],
  ["--_arrow", "--accent", 85],
  ["--_node-fill", "--surface", 3],
  ["--_node-stroke", "--border", 20],
  ["--_group-hdr", null, 5],
];

const mix = (pct) => "color-mix(in srgb, var(--fg) " + pct + "%, var(--bg))";

// SVG 内嵌 <style>：把 --bg/--fg 派生为内部 --_* 变量
export const styleBlock = (font) => {
  let vars = "--_text:var(--fg);";
  for (const [name, override, pct] of MIX)
    vars += name + ":" + (override ? "var(" + override + "," + mix(pct) + ")" : mix(pct)) + ";";
  return (
    "<style>" +
    "text{font-family:'" +
    font +
    "',system-ui,sans-serif}" +
    "svg{" +
    vars +
    "}" +
    "</style>"
  );
};

// SVG 开标签 + inline 主题变量。colors 缺省用 DEFAULT_THEME
export const svgOpen = (w, h, colors, transparent) => {
  const c = colors || THEMES[DEFAULT_THEME];
  let vars = "--bg:" + c.bg + ";--fg:" + c.fg;
  for (const k of ["line", "accent", "muted", "surface", "border"])
    if (c[k]) vars += ";--" + k + ":" + c[k];
  const bg = transparent ? "" : ";background:var(--bg)";
  return (
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' +
    w +
    " " +
    h +
    '" width="' +
    w +
    '" height="' +
    h +
    '" style="' +
    vars +
    bg +
    '">'
  );
};
