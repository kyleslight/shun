/**
 * Where a view's interface is loaded from, answered as one total question.
 *
 * The address is the one thing the host needs before it can draw a frame, and it
 * can be missing: a view of the other machine is described by the rail before its
 * files have arrived, and a descriptor that travelled over a link is not a value
 * this machine wrote. Both are ordinary states of the panel — the empty answer is
 * what makes the host say it is opening — while an address it cannot read is not:
 * `new URL('')` throws, a throw inside a render leaves the whole window with an
 * update it never finished, and every later click looks like a dead control.
 *
 * A local view is served over this app's own scheme (`shun-plugin://…`) and a view
 * of the other machine over a tunnel this machine answers, so nothing here may
 * narrow which schemes are allowed: an address that parses is an address to load,
 * and whether it answers is the frame's business, not this function's.
 */
export function pluginViewFrameSource(frameUrl: string | undefined, viewUrl: string | undefined, channel: string) {
  const raw = String(frameUrl || viewUrl || '').trim()
  if (!raw) return ''
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return ''
  }
  // The channel and the host version are this window's, not the package's: they
  // are set on the address handed to the frame, exactly as they always were.
  url.searchParams.set('channel', channel)
  url.searchParams.set('host', '2')
  return url.href
}
