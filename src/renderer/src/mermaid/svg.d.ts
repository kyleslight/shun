/** beautiful-mermaid 风格的主题颜色配置 */
export interface DiagramColors {
  bg: string;
  fg: string;
  line?: string;
  accent?: string;
  muted?: string;
  surface?: string;
  border?: string;
}

/**
 * 把 mermaid 文本转换为 SVG 字符串。
 * @param text   mermaid 源码（支持 flowchart / sequenceDiagram / pie）
 * @param theme  主题名（如 "tokyo-night"）或自定义 DiagramColors 对象
 */
declare const svg: (text: string, theme?: string | DiagramColors) => string;
export default svg;
