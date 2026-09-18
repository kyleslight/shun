/**
 * Decisions a release has to get right when the network is not.
 *
 * A publish is a few hundred bytes of decisions wrapped around many small GitHub reads and a few
 * writes. On this host the connection to github.com drops a third or more of the connections it
 * opens, and every dropped call used to be read as an answer:
 *
 *   - a failed `gh release view` was read as "no release exists yet", so the script created a second
 *     draft for the same tag. The draft id is then resolved with
 *     `[.[] | select(.tag_name==…)] [0]`, which returns the newest match, so the retry uploaded into
 *     the new empty draft and the release ended up split across two of them;
 *   - a version commit whose `git push` failed was never pushed again, because the resume path
 *     returns early once HEAD already declares the version. Every later attempt then failed the
 *     clean-tree check ("local main must exactly match origin/main") and the release deadlocked
 *     until the commit was pushed by hand.
 *
 * Both are decisions about a failure rather than about the network, so they live here where they can
 * be tested without a repository, a remote, or a flaky route.
 */

/** Failures that say the connection failed, not what the repository holds. */
const transientPatterns = [
  /EOF/i,
  /\btimed? ?out\b/i,
  /\btimeout\b/i,
  /connection (?:reset|refused|closed|aborted)/i,
  /proxyconnect/i,
  /broken pipe/i,
  /no such host/i,
  /temporarily unavailable/i,
  /network is unreachable/i,
  /socket hang up/i,
  /unexpected end of/i,
  /stream (?:error|closed)/i,
  /\bHTTP 5\d\d\b/i,
]

/** Failures that are a real answer: repeating the same request cannot change it. */
const decisivePatterns = [
  /not found/i,
  /\bHTTP 4\d\d\b/i,
  /already exists/i,
  /\bValidation Failed\b/i,
]

/**
 * Whether a failed call is worth making again. A call that failed without saying anything is treated
 * as transient: silence is the absence of an answer, and the cost of asking again is a request,
 * while the cost of accepting it as an answer is a release that publishes the wrong thing.
 */
export function transientFailure(message) {
  const text = String(message ?? '').trim()
  if (!text) return true
  if (decisivePatterns.some(pattern => pattern.test(text))) return false
  return transientPatterns.some(pattern => pattern.test(text))
}

/** Whether a failed release lookup answered "this release does not exist" instead of failing to answer. */
export function missingRelease(message) {
  return /not found|\bHTTP 404\b|could not find/i.test(String(message ?? ''))
}

/**
 * A version commit that never reached the remote still owes a push. The resume path returns early
 * once HEAD declares the version being published, so nothing else would ever send it — and without
 * it every later attempt stops at the clean-tree check instead of publishing.
 */
export function needsVersionPush(localHead, remoteHead) {
  const local = String(localHead ?? '').trim()
  if (!local) return false
  return local !== String(remoteHead ?? '').trim()
}

/**
 * Run a synchronous operation again while it is failing transiently, and stop immediately on an
 * answer. `operation` receives the attempt number so a caller can log what it is retrying.
 */
export function retrySync(operation, options = {}) {
  const attempts = Math.max(1, Number(options.attempts) || 4)
  const shouldRetry = options.shouldRetry || transientFailure
  const onRetry = options.onRetry
  let lastError
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return operation(attempt)
    } catch (error) {
      lastError = error
      const message = error instanceof Error ? error.message : String(error)
      if (attempt === attempts || !shouldRetry(message)) throw error
      onRetry?.(attempt, message)
    }
  }
  throw lastError
}
