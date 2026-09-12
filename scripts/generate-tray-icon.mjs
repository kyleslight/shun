import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createCanvas, loadImage } from '@napi-rs/canvas'

// Windows draws tray icons at 16 logical pixels and scales from the closest
// larger source, so derive one 32px image instead of handing the shell the
// 1024px application icon. Run `pnpm assets:tray-icon` after changing the logo.
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const source = await loadImage(await readFile(join(root, 'resources', 'app-icon.png')))
const canvas = createCanvas(32, 32)
canvas.getContext('2d').drawImage(source, 0, 0, 32, 32)
const target = join(root, 'resources', 'tray-icon.png')
await writeFile(target, canvas.toBuffer('image/png'))
console.log(`Generated tray icon at ${target}`)
