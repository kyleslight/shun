/** Normalize only the snapshot's display brackets; preserve the opaque ref identity. */
export function browserNodeRef(value: unknown) {
  const displayed = String(value || '').trim()
  const ref = /^\[((?:p:)?[1-9]\d{0,11})\]$/.exec(displayed)?.[1] || displayed
  if (!/^(?:p:)?[1-9]\d{0,11}$/.test(ref)) throw Error('Browser action requires a fresh ref from browser_snapshot.')
  return ref
}
