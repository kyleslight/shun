/**
 * The renderer is shared across platforms, but the window chrome is not: macOS
 * reserves space for its traffic lights while Windows and Linux have none.
 * Styling reads this classification instead of assuming a macOS window.
 */
export type RendererPlatform = 'mac' | 'windows' | 'linux'

export function rendererPlatform(value: string | undefined): RendererPlatform {
  const platform = value || ''
  if (/mac/i.test(platform)) return 'mac'
  if (/win/i.test(platform)) return 'windows'
  return 'linux'
}
