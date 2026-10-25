import { Markdown, type MarkdownTheme } from '@earendil-works/pi-tui'
import { accent } from './welcome.ts'
const style = (open: number, close: number) => (text: string) => `\x1b[${open}m${text}\x1b[${close}m`
const dim = style(2, 22)
export const markdownTheme: MarkdownTheme = {
  heading: text => style(1, 22)(accent(text)), link: accent, linkUrl: dim,
  code: accent, codeBlock: text => text, codeBlockBorder: text => dim(text.replace(/^```(.*)$/, (_, language) => language ? `─ ${language}` : '─')),
  quote: dim, quoteBorder: dim, hr: dim, listBullet: accent,
  bold: style(1, 22), italic: style(3, 23), strikethrough: style(9, 29), underline: style(4, 24),
}
export function answerMarkdown(text: string) { return new Markdown(text, 1, 0, markdownTheme) }
const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
export function activityPhase(phase: string, running: boolean, frame: number) {
  return running ? `${frames[frame % frames.length]} ${phase || 'Thinking'}` : phase
}
