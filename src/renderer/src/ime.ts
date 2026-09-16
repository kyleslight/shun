/**
 * Whether a keystroke belongs to an input method rather than to the composer.
 *
 * A Chinese, Japanese, or Korean IME uses Enter to commit the composition, so a
 * composer that submits on that keystroke sends a half-typed word the moment the
 * user is still choosing between candidates. Three signals are needed because
 * implementations differ: Chromium reports the commit as composing, older paths
 * only report keyCode 229, and some input methods close the composition just
 * before the commit reaches the page.
 *
 * The grace window is deliberately short: it only has to outlive the keystroke
 * that ends a composition, and a missed Enter costs one keypress while a false
 * submit sends an unfinished message.
 */
export const compositionGraceMs = 60

export type CompositionKeyEvent = {
  key?: string
  isComposing?: boolean
  keyCode?: number
  nativeEvent?: { isComposing?: boolean; keyCode?: number }
}

export function isComposingEnter(event: CompositionKeyEvent, compositionEndedAt: number, now = Date.now()) {
  if (event.key !== 'Enter') return false
  if (event.isComposing === true || event.nativeEvent?.isComposing === true) return true
  if (event.keyCode === 229 || event.nativeEvent?.keyCode === 229) return true
  return now - compositionEndedAt < compositionGraceMs
}
