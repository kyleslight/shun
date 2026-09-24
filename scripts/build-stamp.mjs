import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { relative } from 'node:path'

/**
 * Build stamps for the native drivers.
 *
 * A driver is compiled only when the bytes that produce it changed: the sources
 * it is built from and the script that builds it, whose flags and target list are
 * part of the build. The file's modification time is deliberately not consulted,
 * so a checkout or a `touch` never costs a compile, and a changed source always
 * does.
 */

export function sourceDigest(root, files) {
  const hash = createHash('sha256')
  for (const file of [...files].sort()) {
    hash.update(relative(root, file))
    hash.update(readFileSync(file))
  }
  return hash.digest('hex')
}

export function isFresh(output, digest, force = false) {
  if (force || !existsSync(output)) return false
  const stamp = `${output}.stamp`
  if (!existsSync(stamp)) return false
  return readFileSync(stamp, 'utf8').trim() === digest
}

export function recordStamp(output, digest) {
  writeFileSync(`${output}.stamp`, `${digest}\n`)
}
