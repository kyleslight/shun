/**
 * `engines.shun` compatibility ranges for plugin packages.
 *
 * The accepted syntax is deliberately a small, closed subset of semver ranges
 * so that a plugin author, the registry, and the host can never disagree about
 * what a declared range means. A range is `*`, or one through four
 * space-separated comparators, and every comparator must use a full
 * `major.minor.patch` version:
 *
 *     *                     any Shun build
 *     >=0.1.34              at least 0.1.34
 *     ^0.2.0                >=0.2.0 <0.3.0
 *     ~1.2.3                >=1.2.3 <1.3.0
 *     >=0.2.0 <0.3.0        an explicit window
 *
 * Prerelease and build metadata are not accepted inside a range. A host build
 * that carries a prerelease tag (`0.2.0-rc.1`) is compared by its release
 * triple, so development builds keep satisfying the range that their release
 * will satisfy.
 */

const comparatorPattern = /^(>=|<=|>|<|=|\^|~)(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
const hostVersionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/
const MAX_RANGE_LENGTH = 64
const MAX_COMPARATORS = 4

type Triple = [number, number, number]

/**
 * Validate a declared `engines.shun` value and return it unchanged, or
 * `undefined` when the manifest does not declare one. An undeclared engine
 * means "every Shun build", which keeps existing packages valid.
 */
export function validateShunEngine(value: unknown, label = 'engines.shun'): string | undefined {
  if (value === undefined || value === null || value === '') return undefined
  const range = String(value).trim()
  if (range.length > MAX_RANGE_LENGTH) throw Error(`${label} must be at most ${MAX_RANGE_LENGTH} characters.`)
  if (range === '*') return range
  const comparators = range.split(/\s+/)
  if (!comparators.length || comparators.length > MAX_COMPARATORS) throw Error(`${label} must contain 1-${MAX_COMPARATORS} comparators.`)
  for (const comparator of comparators) if (!comparatorPattern.test(comparator)) throw Error(`${label} must use full versions, for example "^0.2.0" or ">=0.1.34 <1.0.0".`)
  return range
}

/** True when `hostVersion` satisfies `range`; an absent range always matches. */
export function satisfiesShunEngine(hostVersion: string, range: string | undefined): boolean {
  if (!range || range === '*') return true
  const host = parseTriple(hostVersion)
  if (!host) return false
  return range.split(/\s+/).every(comparator => satisfiesComparator(host, comparator))
}

function satisfiesComparator(host: Triple, comparator: string): boolean {
  const match = comparatorPattern.exec(comparator)!
  const target: Triple = [Number(match[2]), Number(match[3]), Number(match[4])]
  switch (match[1]) {
    case '>=': return compare(host, target) >= 0
    case '<=': return compare(host, target) <= 0
    case '>': return compare(host, target) > 0
    case '<': return compare(host, target) < 0
    case '=': return compare(host, target) === 0
    case '^': return compare(host, target) >= 0 && compare(host, caretCeiling(target)) < 0
    default: return compare(host, target) >= 0 && compare(host, tildeCeiling(target)) < 0
  }
}

/** `^0.2.3` stays inside the minor line, `^1.2.3` inside the major line. */
function caretCeiling([major, minor, patch]: Triple): Triple {
  if (major > 0) return [major + 1, 0, 0]
  if (minor > 0) return [0, minor + 1, 0]
  return [0, 0, patch + 1]
}

function tildeCeiling([major, minor]: Triple): Triple {
  return [major, minor + 1, 0]
}

function parseTriple(version: string): Triple | undefined {
  const match = hostVersionPattern.exec(String(version || '').trim())
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined
}

function compare(left: Triple, right: Triple): number {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] < right[index] ? -1 : 1
  }
  return 0
}
