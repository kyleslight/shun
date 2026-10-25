import { createRequire } from 'node:module'

type Clipboard = { hasImage(): boolean; getImageBinary(): Promise<number[]> }
const require = createRequire(import.meta.url)
export async function clipboardImage(load: () => Clipboard = nativeClipboard): Promise<Buffer> {
  if (process.env.SSH_CONNECTION || process.env.SSH_TTY) throw Error('This remote terminal cannot read your local clipboard. Attach a file with /attach, or run Shun locally.')
  const clipboard = load()
  if (!clipboard.hasImage()) throw Error('No image in the clipboard. Copy an image and try again.')
  const bytes = Buffer.from(await clipboard.getImageBinary())
  if (!bytes.length || bytes.length > 20 * 1024 * 1024) throw Error('Clipboard image must be between 1 byte and 20 MB.')
  return bytes
}
function nativeClipboard(): Clipboard {
  const packages: Record<string, string> = {
    'darwin-arm64': '@mariozechner/clipboard-darwin-arm64',
    'darwin-x64': '@mariozechner/clipboard-darwin-x64',
    'linux-x64': '@mariozechner/clipboard-linux-x64-gnu',
    'win32-x64': '@mariozechner/clipboard-win32-x64-msvc',
  }
  try { return require(packages[`${process.platform}-${process.arch}`] || '@mariozechner/clipboard') }
  catch { throw Error('Image clipboard is unavailable on this installation. Use /attach with an image file path.') }
}
