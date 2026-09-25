import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deflateSync } from 'node:zlib'
import { createCanvas, loadImage } from '@napi-rs/canvas'

/**
 * Every product mark, generated from one master.
 *
 * `resources/shun-logo-source.png` is the single source of truth: a 1024px
 * opaque square of the mark. Everything else in this repo, in the site, and in
 * the mobile app is derived from it here, so the three products cannot drift
 * apart. Run `pnpm assets:brand`, then the two scripts that read the app icon
 * it writes (`pnpm assets:tray-icon`, `pnpm assets:browser-extension`).
 *
 * Two derived forms, and the difference matters:
 *
 * - the **app icon** is the master's full-bleed artwork. iOS, Android and the
 *   favicon mask it into their own shape, so it carries no transparency. macOS
 *   is the exception on both counts: it fits app icons into its own grid, and an
 *   icon whose artwork fills the canvas is normalised against that grid, which
 *   leaves it reading smaller and flatter than the icons beside it in the Dock,
 *   Finder and Raycast. So the macOS family is drawn on Apple's template —
 *   artwork at 824/1024 of the canvas, with the soft shadow Apple's own icons
 *   carry — while Windows, Linux and the browser keep the flat full-bleed tile
 *   that suits a platform with no such grid.
 * - the **mark** is the artwork without its tile, for places that show it on
 *   their own background (the desktop sidebar, the site header, the launch
 *   screen). The master's background is near-black, so the tile is dropped by
 *   lifting each pixel into an alpha derived from its own luminance, which
 *   keeps the glow around the mark instead of cutting it off with a hard key.
 *
 * The site and mobile roots are guessed as siblings and skipped when absent, so
 * a clone of this repo alone can still regenerate its own icons.
 */
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const options = new Map(process.argv.slice(2).map(argument => {
  const [key, value = ''] = argument.replace(/^--/, '').split('=')
  return [key, value]
}))

const siteRoot = resolve(options.get('site') || join(root, '..', 'shun-site'))
const mobileRoot = resolve(options.get('mobile') || join(root, '..', '..', 'rn', 'shun-mobile'))
const masterPath = join(root, 'resources', 'shun-logo-source.png')
const master = await loadImage(await readFile(masterPath))
const written = []

// PNG cannot say "this image is opaque"; a colour type of 6 always carries an
// alpha channel, and App Store validation rejects an app icon that has one. So
// opaque artwork is encoded here as a true three-channel PNG.
const crcTable = Array.from({ length: 256 }, (_, index) => {
  let value = index
  for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
  return value >>> 0
})

function crc32(buffer) {
  let crc = 0xffffffff
  for (const byte of buffer) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function rgbPng(canvas) {
  const { width, height } = canvas
  const rgba = canvas.getContext('2d').getImageData(0, 0, width, height).data
  const stride = width * 3
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y += 1) {
    const row = y * (stride + 1)
    for (let x = 0; x < width; x += 1) {
      const from = (y * width + x) * 4
      const to = row + 1 + x * 3
      raw[to] = rgba[from]
      raw[to + 1] = rgba[from + 1]
      raw[to + 2] = rgba[from + 2]
    }
  }
  const chunk = (type, data) => {
    const length = Buffer.alloc(4)
    length.writeUInt32BE(data.length, 0)
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const checksum = Buffer.alloc(4)
    checksum.writeUInt32BE(crc32(body), 0)
    return Buffer.concat([length, body, checksum])
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8 // bit depth
  header[9] = 2 // colour type: truecolour, no alpha
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

async function save(path, canvas, { opaque = false } = {}) {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, opaque ? rgbPng(canvas) : canvas.toBuffer('image/png'))
  written.push(`${path.slice(root.length + 1)} (${canvas.width}×${canvas.height})`)
}

/** The master itself: opaque, full-bleed, the shape each platform masks. */
function artwork(size) {
  const canvas = createCanvas(size, size)
  canvas.getContext('2d').drawImage(master, 0, 0, size, size)
  return canvas
}

/**
 * A superellipse path with the exponent macOS and iOS draw their icons with.
 * Its corner measures out to the same radius as the platform's own ~22% mask,
 * but transitions continuously instead of turning sharply into a circle.
 */
function squirclePath(ctx, size, exponent = 5) {
  const half = size / 2
  const samples = 1440
  ctx.beginPath()
  for (let index = 0; index <= samples; index += 1) {
    const angle = (index / samples) * Math.PI * 2
    const cos = Math.cos(angle)
    const sin = Math.sin(angle)
    const x = half + Math.sign(cos) * Math.abs(cos) ** (2 / exponent) * half
    const y = half + Math.sign(sin) * Math.abs(sin) ** (2 / exponent) * half
    if (index === 0) ctx.moveTo(x, y)
    else ctx.lineTo(x, y)
  }
  ctx.closePath()
}

/** The app icon as macOS renders it: the artwork inside the platform's shape. */
function squircleArtwork(size) {
  const canvas = createCanvas(size, size)
  const ctx = canvas.getContext('2d')
  squirclePath(ctx, size)
  ctx.clip()
  ctx.drawImage(master, 0, 0, size, size)
  return canvas
}

// Apple's macOS template puts the artwork at 824 of a 1024 canvas and lights it
// with a soft shadow. Rendering on that grid is what keeps the tile from being
// normalised — and so visually shrunk — by the system beside Apple's own icons.
const MACOS_ARTWORK = 824 / 1024
const MACOS_SHADOW = { alpha: 0.34, blur: 0.026, offsetY: 0.012 }

function macosIcon(size) {
  const canvas = createCanvas(size, size)
  const ctx = canvas.getContext('2d')
  const artwork = size * MACOS_ARTWORK
  const offset = (size - artwork) / 2
  ctx.save()
  ctx.translate(offset, offset)
  ctx.save()
  ctx.shadowColor = `rgba(0,0,0,${MACOS_SHADOW.alpha})`
  ctx.shadowBlur = size * MACOS_SHADOW.blur
  ctx.shadowOffsetY = size * MACOS_SHADOW.offsetY
  ctx.fillStyle = '#000'
  squirclePath(ctx, artwork)
  ctx.fill()
  ctx.restore()
  squirclePath(ctx, artwork)
  ctx.clip()
  ctx.drawImage(master, 0, 0, artwork, artwork)
  ctx.restore()
  return canvas
}

// The extraction runs once at master resolution and is then scaled, so a 60px
// App Store icon and a 1024px launch mark share the same edge quality.
const mark = (() => {
  const source = createCanvas(master.width, master.height)
  const sourceCtx = source.getContext('2d')
  sourceCtx.drawImage(master, 0, 0)
  const image = sourceCtx.getImageData(0, 0, master.width, master.height)
  const pixels = image.data
  // The master's tile sits at ~3-4% luminance and its bloom reaches across most
  // of the square, so a naive luminance key would carry that bloom into a
  // visible haze patch — obvious wherever the mark lands on a light surface or
  // gets flattened to a silhouette. Cutting at the measured tile level and
  // compressing what is left keeps a glow around the mark instead.
  const floor = 12 / 255
  for (let index = 0; index < pixels.length; index += 4) {
    const red = pixels[index]
    const green = pixels[index + 1]
    const blue = pixels[index + 2]
    const peak = Math.max(red, green, blue)
    const alpha = Math.min(1, Math.max(0, peak / 255 - floor) / (1 - floor))
    if (alpha <= 0) {
      pixels[index + 3] = 0
      continue
    }
    const scale = 255 / peak
    pixels[index] = Math.min(255, red * scale)
    pixels[index + 1] = Math.min(255, green * scale)
    pixels[index + 2] = Math.min(255, blue * scale)
    pixels[index + 3] = Math.round(alpha ** 1.4 * 255)
  }
  return image
})()

function markCanvas(size) {
  const extracted = createCanvas(master.width, master.height)
  extracted.getContext('2d').putImageData(mark, 0, 0)
  const canvas = createCanvas(size, size)
  canvas.getContext('2d').drawImage(extracted, 0, 0, size, size)
  return canvas
}

/**
 * The same mark flattened to a silhouette, for the layer an Android 13+ launcher
 * tints to its own theme. The threshold keeps the blade's edge instead of
 * carrying its glow through, which a tint would smear into a blob.
 */
const monochromeMark = (() => {
  const canvas = createCanvas(master.width, master.height)
  const ctx = canvas.getContext('2d')
  ctx.putImageData(mark, 0, 0)
  const image = ctx.getImageData(0, 0, master.width, master.height)
  const pixels = image.data
  for (let index = 0; index < pixels.length; index += 4) {
    const opaque = pixels[index + 3] >= 128 ? 255 : 0
    pixels[index] = 255
    pixels[index + 1] = 255
    pixels[index + 2] = 255
    pixels[index + 3] = opaque
  }
  ctx.putImageData(image, 0, 0)
  return canvas
})()

// The tile's own colour, sampled from the master's background pixels, so the
// adaptive icon's flat layer meets the artwork without a seam.
const tileColour = (() => {
  const source = createCanvas(master.width, master.height)
  const ctx = source.getContext('2d')
  ctx.drawImage(master, 0, 0)
  const pixels = ctx.getImageData(0, 0, master.width, master.height).data
  let red = 0
  let green = 0
  let blue = 0
  let count = 0
  for (let index = 0; index < pixels.length; index += 4) {
    if (Math.max(pixels[index], pixels[index + 1], pixels[index + 2]) > 20) continue
    red += pixels[index]
    green += pixels[index + 1]
    blue += pixels[index + 2]
    count += 1
  }
  const hex = value => Math.round(value / count).toString(16).padStart(2, '0')
  return `#${hex(red)}${hex(green)}${hex(blue)}`
})()

/**
 * One adaptive-icon layer: the artwork placed inside the safe area of a 108dp
 * canvas, so no launcher mask — circle, squircle or rounded square — can cut it.
 */
const ANDROID_ARTWORK = 0.72

function androidLayer(source, size) {
  const canvas = createCanvas(size, size)
  const artwork = size * ANDROID_ARTWORK
  canvas.getContext('2d').drawImage(source, (size - artwork) / 2, (size - artwork) / 2, artwork, artwork)
  return canvas
}

function adaptiveIconXml() {
  return `<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@color/ic_launcher_background" />
    <foreground android:drawable="@mipmap/ic_launcher_foreground" />
    <monochrome android:drawable="@mipmap/ic_launcher_monochrome" />
</adaptive-icon>
`
}

function colourResourceXml(colour) {
  return `<?xml version="1.0" encoding="utf-8"?>
<resources>
    <color name="ic_launcher_background">${colour}</color>
</resources>
`
}

/**
 * macOS reads a .icns, so the iconset is assembled at every scale the Dock,
 * Finder and the switcher ask for and handed to iconutil.
 */
async function writeIcns() {
  const iconset = join(root, 'tmp', 'app-icon.iconset')
  await rm(iconset, { recursive: true, force: true })
  await mkdir(iconset, { recursive: true })
  const sizes = [16, 32, 128, 256, 512]
  for (const size of sizes) {
    await writeFile(join(iconset, `icon_${size}x${size}.png`), macosIcon(size).toBuffer('image/png'))
    await writeFile(join(iconset, `icon_${size}x${size}@2x.png`), macosIcon(size * 2).toBuffer('image/png'))
  }
  const target = join(root, 'resources', 'app-icon.icns')
  execFileSync('iconutil', ['-c', 'icns', iconset, '-o', target])
  await rm(iconset, { recursive: true, force: true })
  written.push('resources/app-icon.icns')
}

// This repo: the icon the installer, the README and the browser extension show
// (flat, full-bleed), the macOS template the bundle icon and the Dock are built
// from, and the mark the sidebar and empty state draw.
await save(join(root, 'resources', 'app-icon-source.png'), macosIcon(1254))
await save(join(root, 'resources', 'app-icon.png'), squircleArtwork(1024))
await save(join(root, 'src', 'renderer', 'src', 'assets', 'shun-logo.png'), markCanvas(512))
await writeIcns()

// Mobile: iOS masks the artwork itself, so the AppIcon set is plain full-bleed
// squares with no alpha — App Store validation rejects an alpha channel — and
// Android's legacy launcher icons take the same artwork at each density.
if (existsSync(mobileRoot)) {
  const appIconSet = join(mobileRoot, 'ios', 'ShunMobile', 'Images.xcassets', 'AppIcon.appiconset')
  const icons = [
    ['AppIcon-20.png', 20], ['AppIcon-20@2x.png', 40], ['AppIcon-20@3x.png', 60],
    ['AppIcon-29.png', 29], ['AppIcon-29@2x.png', 58], ['AppIcon-29@3x.png', 87],
    ['AppIcon-40.png', 40], ['AppIcon-40@2x.png', 80], ['AppIcon-40@3x.png', 120],
    ['AppIcon-60@2x.png', 120], ['AppIcon-60@3x.png', 180],
    ['AppIcon-76.png', 76], ['AppIcon-76@2x.png', 152], ['AppIcon-83.5@2x.png', 167],
    ['AppIcon-1024.png', 1024],
  ]
  for (const [name, size] of icons) await save(join(appIconSet, name), artwork(size), { opaque: true })
  const densities = [['mdpi', 48], ['hdpi', 72], ['xhdpi', 96], ['xxhdpi', 144], ['xxxhdpi', 192]]
  for (const [density, size] of densities) {
    const target = join(mobileRoot, 'android', 'app', 'src', 'main', 'res', `mipmap-${density}`)
    await save(join(target, 'ic_launcher.png'), artwork(size), { opaque: true })
    await save(join(target, 'ic_launcher_round.png'), artwork(size), { opaque: true })
  }
  // Android 8+ has no adaptive icon to fall back on here, so it draws the flat
  // legacy icon inside a white plate — the ring you see around it on Android.
  // The adaptive layers fix that: a flat colour behind, the mark in front, and a
  // silhouette the launcher tints on Android 13+.
  const layers = [['mdpi', 108], ['hdpi', 162], ['xhdpi', 216], ['xxhdpi', 324], ['xxxhdpi', 432]]
  for (const [density, size] of layers) {
    const target = join(mobileRoot, 'android', 'app', 'src', 'main', 'res', `mipmap-${density}`)
    await save(join(target, 'ic_launcher_foreground.png'), androidLayer(markCanvas(master.width), size))
    await save(join(target, 'ic_launcher_monochrome.png'), androidLayer(monochromeMark, size))
  }
  const resource = join(mobileRoot, 'android', 'app', 'src', 'main', 'res')
  const adaptive = join(resource, 'mipmap-anydpi-v26', 'ic_launcher.xml')
  await mkdir(dirname(adaptive), { recursive: true })
  await writeFile(adaptive, adaptiveIconXml())
  written.push('android/app/src/main/res/mipmap-anydpi-v26/ic_launcher.xml')
  await writeFile(join(resource, 'values', 'ic_launcher_background.xml'), colourResourceXml(tileColour))
  written.push(`android/app/src/main/res/values/ic_launcher_background.xml (${tileColour})`)
  // The launch screen sits the mark on its own background, so it takes the
  // extracted form rather than the tile.
  await save(join(mobileRoot, 'ios', 'ShunMobile', 'Images.xcassets', 'LaunchMark.imageset', 'LaunchMark.png'), markCanvas(1024))
} else {
  console.warn(`Skipped mobile assets: no project at ${mobileRoot}`)
}

// Site: the favicon and the touch icon are the app icon at the sizes the web
// asks for, and the header mark and social card take the extracted form.
if (existsSync(siteRoot)) {
  await save(join(siteRoot, 'public', 'logo.png'), markCanvas(320))
  await save(join(siteRoot, 'src', 'app', 'icon.png'), squircleArtwork(512))
  // Apple composites a transparent touch icon onto black, so this one is opaque.
  await save(join(siteRoot, 'src', 'app', 'apple-icon.png'), artwork(180), { opaque: true })
} else {
  console.warn(`Skipped site assets: no project at ${siteRoot}`)
}

console.log(`Generated ${written.length} brand assets from resources/shun-logo-source.png:`)
for (const entry of written) console.log(`  ${entry}`)
