import clean from "./clean.js";
import detect from "./detect.js";
import { THEMES, DEFAULT_THEME, svgOpen, styleBlock } from "./theme.js";
import { PIE, SEQUENCE, FLOWCHART, CLASS, STATE, ER, XYCHART, JOURNEY, TIMELINE, MINDMAP, QUADRANT, KANBAN, PACKET, REQUIREMENT, GITGRAPH, GANTT, SANKEY, BLOCK } from "./const/TYPE.js";
import pie from "./pie/render.js";
import seq from "./seq/render.js";
import flow from "./flow/render.js";
import cls from "./cls/render.js";
import state from "./state/render.js";
import er from "./er/render.js";
import xy from "./xy/render.js";
import journey from "./journey/render.js";
import timeline from "./timeline/render.js";
import mindmap from "./mindmap/render.js";
import quadrant from "./quadrant/render.js";
import kanban from "./kanban/render.js";
import packet from "./packet/render.js";
import req from "./req/render.js";
import git from "./git/render.js";
import gantt from "./gantt/render.js";
import sankey from "./sankey/render.js";
import block from "./block/render.js";

const FONT = "Inter";

const RENDER = {
  [PIE]: pie, [SEQUENCE]: seq, [FLOWCHART]: flow, [CLASS]: cls, [STATE]: state, [ER]: er, [XYCHART]: xy,
  [JOURNEY]: journey, [TIMELINE]: timeline, [MINDMAP]: mindmap, [QUADRANT]: quadrant, [KANBAN]: kanban,
  [PACKET]: packet, [REQUIREMENT]: req, [GITGRAPH]: git, [GANTT]: gantt, [SANKEY]: sankey, [BLOCK]: block,
};

// 解析主题入参：字符串名 / colors 对象 / 空
const themeOf = (theme, fm_theme) => {
  if (theme && typeof theme === "object") return theme;
  const name = (typeof theme === "string" && theme) || fm_theme;
  return THEMES[name] || THEMES[DEFAULT_THEME];
};

// 主入口：mermaid 文本 → svg 字符串。theme 可选（名字或 colors 对象）
const svg = (text, theme) => {
  const [body, cfg] = clean(text),
    type = detect(body),
    render = RENDER[type];
  if (!render) throw new Error("unsupported diagram type");
  const [w, h, inner] = render(body),
    colors = themeOf(theme, cfg.theme);
  return svgOpen(w, h, colors) + styleBlock(FONT) + inner + "</svg>";
};

export default svg;
