const affectedElectronMajors = new Set([43])

/**
 * Work around a native V8 JIT-page registration crash observed on macOS 26
 * ARM64. Keep the Electron-major gate explicit so upgrades must re-evaluate
 * the workaround instead of silently carrying it forever.
 */
export function needsJitlessRenderer(platform: string, arch: string, osRelease: string, electronVersion: string) {
  const darwinMajor = Number.parseInt(osRelease.split('.')[0] || '', 10)
  const electronMajor = Number.parseInt(electronVersion.split('.')[0] || '', 10)
  return platform === 'darwin' && arch === 'arm64' && darwinMajor >= 25 && affectedElectronMajors.has(electronMajor)
}

/** Recover a one-off native renderer crash, but do not create a reload loop. */
export function shouldRecoverRenderer(reason: string, elapsedSinceRecovery: number) {
  return reason !== 'clean-exit' && elapsedSinceRecovery >= 30_000
}

/** Keep generated app links from replacing Shun's own renderer. */
export function isTrustedRendererNavigation(candidate: string, rendererUrl: string) {
  try {
    const next = new URL(candidate)
    const trusted = new URL(rendererUrl)
    if (trusted.protocol === 'file:') return next.href === trusted.href
    return next.origin === trusted.origin
  } catch {
    return false
  }
}

export function isExternalWebUrl(candidate: string) {
  try {
    return ['http:', 'https:'].includes(new URL(candidate).protocol)
  } catch {
    return false
  }
}

type WindowKeyInput = {
  key: string
  control: boolean
  meta: boolean
  shift: boolean
  alt: boolean
}

/** Installed builds do not expose renderer reload or Chromium inspection shortcuts. */
export function isBlockedProductionWindowShortcut(input: WindowKeyInput) {
  const key = input.key.toLowerCase()
  const primary = input.control || input.meta
  if (key === 'f5' || key === 'f12') return true
  if (primary && key === 'r') return true
  if (input.control && input.shift && ['i', 'j', 'c'].includes(key)) return true
  return input.meta && input.alt && ['i', 'j', 'c'].includes(key)
}
