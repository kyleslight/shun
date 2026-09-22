import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createCanvas, loadImage } from '@napi-rs/canvas'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const extensionIcons = join(root, 'resources', 'browser-use-extension', 'icons')
const appIcon = await loadImage(await readFile(join(root, 'resources', 'app-icon.png')))
await mkdir(extensionIcons, { recursive: true })

async function save(path, canvas) {
  await writeFile(path, canvas.toBuffer('image/png'))
}

for (const size of [16, 32, 48]) {
  const canvas = createCanvas(size, size)
  canvas.getContext('2d').drawImage(appIcon, 0, 0, size, size)
  await save(join(extensionIcons, `icon-${size}.png`), canvas)
}

// Chrome Web Store guidance asks for 16 transparent pixels around the 96px
// artwork in the 128px icon file.
const icon128 = createCanvas(128, 128)
icon128.getContext('2d').drawImage(appIcon, 16, 16, 96, 96)
await save(join(extensionIcons, 'icon-128.png'), icon128)

// The ring the toolbar icon turns through while a tab is being driven. It is drawn here rather
// than in the worker because `setIcon` takes pixels and a service worker has no canvas to make
// them with: the run that first needed this animation showed the tab strip turning while the
// toolbar icon stayed still, which is exactly what a canvas that throws inside a caught block
// looks like from the outside.
const markFrames = 8
for (let index = 0; index < markFrames; index += 1) {
  const canvas = createCanvas(32, 32)
  const context = canvas.getContext('2d')
  const turn = ((360 / markFrames) * index - 90) * (Math.PI / 180)
  context.fillStyle = '#4f46e5'
  context.beginPath()
  context.roundRect(0, 0, 32, 32, 9)
  context.fill()
  context.strokeStyle = '#c7d2fe'
  context.lineWidth = 2.2
  context.lineCap = 'round'
  context.beginPath()
  // 30 of the ring's 44 units are drawn, matching the tab strip's dash.
  context.arc(16, 16, 7, turn, turn + Math.PI * 2 * (30 / 44))
  context.stroke()
  context.fillStyle = '#ffffff'
  context.beginPath()
  context.arc(16, 16, 3.4, 0, Math.PI * 2)
  context.fill()
  await save(join(extensionIcons, `mark-${index + 1}.png`), canvas)
}
console.log(`Generated Browser Use icons in ${extensionIcons}`)
