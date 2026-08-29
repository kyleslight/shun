import { Transform } from 'node:stream'

const ignoredMacInputDiagnostics = [
  'TSM AdjustCapsLockLEDForKeyTransitionHandling - _ISSetPhysicalKeyboardCapsLockLED Inhibit',
  'error messaging the mach port for IMKCFRunLoopWakeUpReliable',
]

export function isIgnoredDevStderrLine(line, platform = process.platform) {
  return platform === 'darwin' && ignoredMacInputDiagnostics.some(diagnostic => line.includes(diagnostic))
}

export function createDevStderrFilter(platform = process.platform) {
  let pending = ''
  return new Transform({
    transform(chunk, _encoding, callback) {
      pending += chunk.toString()
      const lines = pending.split(/(?<=\n)/)
      pending = lines.pop() || ''
      callback(null, lines.filter(line => !isIgnoredDevStderrLine(line, platform)).join(''))
    },
    flush(callback) {
      callback(null, isIgnoredDevStderrLine(pending, platform) ? '' : pending)
    },
  })
}
