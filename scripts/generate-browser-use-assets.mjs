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
console.log(`Generated Browser Use icons in ${extensionIcons}`)
