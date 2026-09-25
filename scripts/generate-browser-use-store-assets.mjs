import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createCanvas, loadImage } from '@napi-rs/canvas'

/**
 * Chrome Web Store listing artwork for Shun Browser Use.
 *
 * The store requires at least one 1280×800 screenshot, and the small promo
 * tile is worth having. Everything here is drawn from the extension's own
 * popup markup and copy — a screenshot that shows states the extension does
 * not have would be a lie the reviewers can check.
 *
 * Output lives in docs/, which is outside the packaged `files` list, so the
 * listing art never ships inside the application.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const out = join(root, 'docs', 'browser-use-store')
const appIcon = await loadImage(await readFile(join(root, 'resources', 'app-icon.png')))

const INK = '#0b0d10', PAPER = '#edeef0', MUTED = '#8b919b', DIM = '#5c626c', LINE = 'rgba(255,255,255,0.10)'
const ACCENT = '#fb0f77', GREEN = '#75b58d', PANEL = '#1c1c1c', PANEL_LINE = '#333333'

const sans = (weight, size) => `${weight} ${size}px "Helvetica Neue", Helvetica, Arial, sans-serif`
const mono = (size) => `${size}px "SF Mono", Menlo, Consolas, monospace`

function rounded(ctx, x, y, w, h, r) {
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.arcTo(x + w, y, x + w, y + h, r)
  ctx.arcTo(x + w, y + h, x, y + h, r)
  ctx.arcTo(x, y + h, x, y, r)
  ctx.arcTo(x, y, x + w, y, r)
  ctx.closePath()
}

/** The extension popup, drawn from popup.html at a readable scale. */
function drawPopup(ctx, { x, y, scale, connected, controlledTabs = 0 }) {
  const pad = 18 * scale
  const width = 300 * scale
  const icon = 24 * scale

  const wrap = (text, font, maxWidth) => {
    ctx.font = font
    const words = text.split(' ')
    const lines = []
    let line = ''
    for (const word of words) {
      const candidate = line ? `${line} ${word}` : word
      if (ctx.measureText(candidate).width > maxWidth && line) { lines.push(line); line = word }
      else line = candidate
    }
    if (line) lines.push(line)
    return lines
  }

  const bodyFont = sans(400, 13 * scale)
  const detailFont = sans(400, 11 * scale)
  const paragraph = wrap(
    'Lets Shun control a Chrome tab while a task is running. Debugging detaches automatically when the run ends.',
    bodyFont,
    width - pad * 2,
  )
  const detail = connected
    ? `${controlledTabs} controlled tab${controlledTabs === 1 ? '' : 's'}`
    : 'Keep Shun open, then connect to allow local network access.'
  const detailLines = wrap(detail, detailFont, width - pad * 2 - 16 * scale)

  const lineHeight = 18.85 * scale
  const headerHeight = icon + 20 * scale
  const buttonHeight = connected ? 0 : 44 * scale
  const height = pad + headerHeight + paragraph.length * lineHeight + 20 * scale
    + 30 * scale + Math.max(16 * scale, detailLines.length * 15 * scale) + buttonHeight + pad

  ctx.save()
  ctx.shadowColor = 'rgba(0,0,0,0.55)'
  ctx.shadowBlur = 40 * scale
  ctx.shadowOffsetY = 12 * scale
  ctx.fillStyle = PANEL
  rounded(ctx, x, y, width, height, 12 * scale)
  ctx.fill()
  ctx.restore()

  ctx.save()
  rounded(ctx, x, y, width, height, 12 * scale)
  ctx.clip()

  ctx.textBaseline = 'middle'
  ctx.drawImage(appIcon, x + pad, y + pad, icon, icon)
  ctx.fillStyle = '#ededed'
  ctx.font = sans(600, 15 * scale)
  ctx.fillText('Shun Browser Use', x + pad + icon + 9 * scale, y + pad + icon / 2)

  ctx.fillStyle = '#aaaaaa'
  ctx.font = bodyFont
  paragraph.forEach((line, index) => ctx.fillText(line, x + pad, y + pad + headerHeight + index * lineHeight))

  const stateY = y + pad + headerHeight + paragraph.length * lineHeight + 20 * scale
  ctx.strokeStyle = PANEL_LINE
  ctx.lineWidth = 1 * scale
  ctx.beginPath()
  ctx.moveTo(x + pad, stateY)
  ctx.lineTo(x + width - pad, stateY)
  ctx.stroke()

  const rowY = stateY + 30 * scale
  ctx.fillStyle = connected ? GREEN : '#777777'
  ctx.beginPath()
  ctx.arc(x + pad + 4 * scale, rowY, 4 * scale, 0, Math.PI * 2)
  ctx.fill()

  ctx.fillStyle = '#ededed'
  ctx.font = sans(700, 12 * scale)
  ctx.fillText(connected ? 'Connected to Shun' : 'Connection required', x + pad + 16 * scale, rowY)

  ctx.fillStyle = '#888888'
  ctx.font = detailFont
  detailLines.forEach((line, index) => ctx.fillText(line, x + pad + 16 * scale, rowY + (17 + index * 15) * scale))

  if (!connected) {
    const buttonY = y + height - pad - 30 * scale
    ctx.fillStyle = '#ededed'
    rounded(ctx, x + pad, buttonY, width - pad * 2, 30 * scale, 7 * scale)
    ctx.fill()
    ctx.fillStyle = '#1c1c1c'
    ctx.font = sans(600, 12 * scale)
    ctx.textAlign = 'center'
    ctx.fillText('Connect to Shun', x + width / 2, buttonY + 15 * scale)
    ctx.textAlign = 'left'
  }

  ctx.restore()
  return { height }
}

function drawFrame(ctx, width, height, { title, badge, note }) {
  ctx.fillStyle = INK
  ctx.fillRect(0, 0, width, height)

  // A quiet edge so the artwork reads as a framed panel rather than a flat fill.
  ctx.strokeStyle = LINE
  ctx.lineWidth = 1
  ctx.strokeRect(0.5, 0.5, width - 1, height - 1)

  const mark = Math.round(height * 0.07)
  ctx.drawImage(appIcon, 84, 88, mark * 2.4, mark * 2.4)

  ctx.fillStyle = PAPER
  ctx.font = sans(500, 54)
  ctx.textBaseline = 'alphabetic'
  ctx.fillText(title, 84, 330)

  ctx.fillStyle = MUTED
  ctx.font = sans(400, 21)
  for (const [index, line] of note.entries()) ctx.fillText(line, 84, 380 + index * 31)

  ctx.fillStyle = DIM
  ctx.font = mono(11.5)
  const labels = badge.split('·').map(part => part.trim())
  labels.forEach((label, index) => {
    const x = 84 + index * 300
    ctx.fillText(label.toUpperCase(), x, height - 92)
  })
  labels.forEach((_, index) => {
    ctx.fillStyle = LINE
    ctx.fillRect(84 + index * 300, height - 74, 240, 1)
    ctx.fillStyle = DIM
  })

  ctx.strokeStyle = LINE
  ctx.beginPath()
  ctx.moveTo(84, height - 132)
  ctx.lineTo(width - 84, height - 132)
  ctx.stroke()
}

async function screenshot(name, state) {
  const width = 1280, height = 800
  const canvas = createCanvas(width, height)
  const ctx = canvas.getContext('2d')
  drawFrame(ctx, width, height, {
    title: 'Shun Browser Use',
    note: [
      'Give a Shun task one Chrome tab.',
      'Your tabs, your logins, your extensions.',
    ],
    badge: 'Local loopback only · Detaches when the run ends · No analytics',
  })
  drawPopup(ctx, { x: width - 96 - 540, y: 190, scale: 1.8, ...state })
  await writeFile(join(out, name), canvas.toBuffer('image/png'))
}

async function promo() {
  const width = 440, height = 280
  const canvas = createCanvas(width, height)
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = INK
  ctx.fillRect(0, 0, width, height)
  ctx.strokeStyle = LINE
  ctx.strokeRect(0.5, 0.5, width - 1, height - 1)

  ctx.drawImage(appIcon, 36, 34, 64, 64)
  ctx.fillStyle = PAPER
  ctx.font = sans(500, 27)
  ctx.fillText('Shun Browser Use', 36, 158)
  ctx.fillStyle = MUTED
  ctx.font = sans(400, 14)
  ctx.fillText('One Chrome tab for a Shun task.', 36, 188)
  ctx.fillText('Local only. Detaches when the run ends.', 36, 210)
  await writeFile(join(out, 'promo-440x280.png'), canvas.toBuffer('image/png'))
}

await mkdir(out, { recursive: true })
await screenshot('screenshot-1280x800-1.png', { connected: false })
await screenshot('screenshot-1280x800-2.png', { connected: true, controlledTabs: 1 })
await promo()
console.log(`Generated Chrome Web Store artwork in ${out}`)
