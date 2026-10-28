import PptxGenJS from 'pptxgenjs'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

export type SlideElement = {
  type: 'text' | 'rect' | 'ellipse'
  x: number; y: number; w: number; h: number
  text?: string; color?: string; fill?: string; fontSize?: number; bold?: boolean
  align?: 'left' | 'center' | 'right'
}
export type PresentationSpec = {
  title: string; author?: string; fontFace?: string
  slides: Array<{ background?: string; elements: SlideElement[] }>
}
const WIDTH = 13.333333, HEIGHT = 7.5
const escapeHtml = (text: string) => text.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
function fields(value: object, allowed: string[]) {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw Error(`Unsupported presentation field: ${key}.`)
}
const color = (value: unknown) => typeof value === 'string' && /^[0-9a-f]{6}$/i.test(value)

// Validate the file as well as the tool arguments: model-written JSON is not a typed value.
export function validatePresentation(value: unknown): PresentationSpec {
  const spec = value as PresentationSpec
  if (!spec || typeof spec.title !== 'string' || spec.title.length > 500) throw Error('Presentation title must be text of at most 500 characters.')
  fields(spec, ['title', 'author', 'fontFace', 'slides'])
  for (const key of ['author', 'fontFace'] as const) if (spec[key] !== undefined && (typeof spec[key] !== 'string' || spec[key]!.length > 200)) throw Error(`Invalid presentation ${key}.`)
  if (!Array.isArray(spec.slides) || !spec.slides.length || spec.slides.length > 60) throw Error('A presentation must contain 1–60 slides.')
  for (const [index, slide] of spec.slides.entries()) {
    if (!slide || (slide.background !== undefined && !color(slide.background))) throw Error(`Invalid background on slide ${index + 1}.`)
    fields(slide, ['background', 'elements'])
    if (!Array.isArray(slide.elements) || slide.elements.length > 200) throw Error(`Slide ${index + 1} must contain at most 200 elements.`)
    for (const element of slide.elements) {
      if (!element || !['text', 'rect', 'ellipse'].includes(element.type)) throw Error(`Unsupported element on slide ${index + 1}; use text, rect, or ellipse.`)
      fields(element, ['type', 'x', 'y', 'w', 'h', 'text', 'color', 'fill', 'fontSize', 'bold', 'align'])
      const { x, y, w, h } = element
      if (![x, y, w, h].every(Number.isFinite) || x < 0 || y < 0 || w <= 0 || h <= 0 || x + w > WIDTH + 0.001 || y + h > HEIGHT + 0.001) throw Error(`An element on slide ${index + 1} extends outside the 13.333 × 7.5 inch slide.`)
      for (const key of ['color', 'fill'] as const) if (element[key] !== undefined && !color(element[key])) throw Error(`Invalid ${key} on slide ${index + 1}; use six hexadecimal digits.`)
      if (element.type === 'text' && (typeof element.text !== 'string' || element.text.length > 10_000)) throw Error(`Invalid text on slide ${index + 1}.`)
      if (element.fontSize !== undefined && (!Number.isFinite(element.fontSize) || element.fontSize < 6 || element.fontSize > 120)) throw Error('Font size must be between 6 and 120 points.')
      if (element.bold !== undefined && typeof element.bold !== 'boolean') throw Error('bold must be a boolean.')
      if (element.align !== undefined && !['left', 'center', 'right'].includes(element.align)) throw Error('Invalid text alignment.')
    }
  }
  return spec
}

export function presentationSlideHtml(spec: PresentationSpec, index: number) {
  const slide = spec.slides[index]
  const elements = slide.elements.map(element => {
    const style = `position:absolute;box-sizing:border-box;left:${element.x * 96}px;top:${element.y * 96}px;width:${element.w * 96}px;height:${element.h * 96}px;${element.fill ? `background:#${element.fill};` : ''}`
    if (element.type !== 'text') return `<div style="${style}background:#${element.fill || 'FFFFFF'};${element.type === 'ellipse' ? 'border-radius:50%;' : ''}"></div>`
    return `<div data-text style="${style}font-size:${(element.fontSize || 24) * 96 / 72}px;color:#${element.color || '17202A'};font-weight:${element.bold ? 700 : 400};text-align:${element.align || 'left'};white-space:pre-wrap;overflow-wrap:break-word;line-height:1.2;">${escapeHtml(element.text || '')}</div>`
  }).join('')
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'none'"><title>${escapeHtml(spec.title)} — ${index + 1}</title><style>html,body{margin:0;width:1280px;height:720px;overflow:hidden}body{font-family:"${escapeHtml(spec.fontFace || 'Arial')}",sans-serif;background:#${slide.background || 'FFFFFF'}}</style></head><body>${elements}</body></html>`
}

export type PresentationRenderer = (html: string, signal?: AbortSignal) => Promise<{ png: Uint8Array; overflowingText: number }>

export async function createPresentation(inputPath: string, outputPath: string, render: PresentationRenderer, signal?: AbortSignal) {
  const input = resolve(inputPath), output = resolve(outputPath)
  if (!/\.pptx$/i.test(output) || input === output) throw Error('Choose a separate .pptx output path.')
  if ((await stat(input)).size > 4 * 1024 * 1024) throw Error('Presentation source exceeds 4 MiB.')
  const source = await readFile(input, 'utf8')
  if (Buffer.byteLength(source) > 4 * 1024 * 1024) throw Error('Presentation source exceeds 4 MiB.')
  const spec = validatePresentation(JSON.parse(source))
  const pptx = new PptxGenJS()
  pptx.layout = 'LAYOUT_WIDE'
  pptx.title = spec.title
  pptx.author = spec.author || 'Shun'
  pptx.subject = spec.title
  pptx.theme = { headFontFace: spec.fontFace || 'Arial', bodyFontFace: spec.fontFace || 'Arial' }
  const previewDirectory = `${output.slice(0, -5)}.preview`
  await mkdir(dirname(output), { recursive: true })
  await mkdir(previewDirectory, { recursive: true })
  const previews: string[] = [], warnings: string[] = []
  for (const [index, definition] of spec.slides.entries()) {
    signal?.throwIfAborted()
    const slide = pptx.addSlide()
    slide.background = { color: definition.background || 'FFFFFF' }
    for (const element of definition.elements) {
      const { x, y, w, h } = element
      if (element.type === 'text') slide.addText(element.text!, {
        x, y, w, h, fontFace: spec.fontFace || 'Arial', fontSize: element.fontSize || 24,
        color: element.color || '17202A', bold: element.bold || false, align: element.align || 'left',
        margin: 0, breakLine: false, valign: 'top', paraSpaceAfter: 0,
        ...(element.fill ? { fill: { color: element.fill } } : {}),
      })
      else slide.addShape(element.type === 'ellipse' ? pptx.ShapeType.ellipse : pptx.ShapeType.rect, {
        x, y, w, h, fill: { color: element.fill || 'FFFFFF' }, line: { transparency: 100 },
      })
    }
    const html = presentationSlideHtml(spec, index)
    const htmlPath = resolve(previewDirectory, `slide-${index + 1}.html`)
    const pngPath = resolve(previewDirectory, `slide-${index + 1}.png`)
    const rendered = await render(html, signal)
    signal?.throwIfAborted()
    if (rendered.overflowingText) warnings.push(`Slide ${index + 1}: ${rendered.overflowingText} text box(es) overflow in the layout preview. Shorten text, enlarge the box, or reduce font size.`)
    await writeFile(htmlPath, html)
    await writeFile(pngPath, rendered.png)
    previews.push(pngPath)
  }
  signal?.throwIfAborted()
  await pptx.writeFile({ fileName: output })
  return { output, slides: spec.slides.length, previews, warnings, previewKind: 'source-layout', note: 'Previews show the source layout, not a rendering by PowerPoint. Font metrics and line wrapping can differ in office applications. Text and shapes in the PPTX remain editable.' }
}
