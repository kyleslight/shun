import { setTimeout as delay } from 'node:timers/promises'

const hasVersion = (revision, version) => revision?.distributionChannels?.some(channel => channel.crxVersion === version)

/** An HTTP acknowledgement, warning, or older public package is not a release receipt. */
export function extensionPublicationReceipt(status, version) {
  const published = status?.publishedItemRevisionStatus
  if (published?.state === 'PUBLISHED' && hasVersion(published, version)) return { version, state: 'PUBLISHED' }
  const submitted = status?.submittedItemRevisionStatus
  if (hasVersion(submitted, version) && ['PENDING_REVIEW', 'STAGED'].includes(submitted.state)) {
    return { version, state: submitted.state }
  }
  return undefined
}

/** Bounded read-only settling; never re-upload or re-submit an uncertain mutation. */
export async function verifyExtensionPublication(readStatus, version, { attempts = 6, wait = () => delay(5_000) } = {}) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const status = await readStatus()
    const receipt = extensionPublicationReceipt(status, version)
    if (receipt) return receipt
    const submitted = status?.submittedItemRevisionStatus
    if (hasVersion(submitted, version) && ['REJECTED', 'CANCELLED'].includes(submitted.state)) {
      throw Error(`Extension ${version} submission is ${submitted.state}; inspect the existing submission.`)
    }
    if (attempt + 1 < attempts) await wait()
  }
  throw Error(`The store has not confirmed submission of extension ${version}. Inspect the existing draft; do not re-upload or change the version merely to retry.`)
}
