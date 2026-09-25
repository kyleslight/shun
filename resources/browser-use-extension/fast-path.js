/**
 * The page-side half of Shun's fast browser path.
 *
 * Browser Use's general path asks the accessibility tree what the page can do. That is
 * the honest answer and it stays the source of truth, but it costs a full AX walk plus a
 * large round trip for every step, and a routine sequence of obvious clicks needs none of
 * it: it needs the controls that are visible right now, their state, and the certainty
 * that the control a decision named is still the one it was.
 *
 * So one evaluate answers the whole observation, and a second one re-checks the named
 * control and prepares it. Nothing here decides anything — it reports what is on the page
 * and refuses to act when the page moved underneath the decision.
 *
 * A control's identity never leaves the page. The registry below hands out small integers,
 * so no selector, coordinate, or synthesized action can arrive from outside, and none is
 * ever accepted: a caller can only name an integer the page itself handed out.
 *
 * This is a plain browser script, loaded into the service worker with importScripts and
 * never run there — its functions are stringified into page expressions. Keeping it in its
 * own file is what lets the stub-DOM test run exactly these functions.
 */

/** Roles a fast decision may act on. Everything else is reported as text, never as a control. */
function shunFastHelpers() {
  const ROLES = ['button', 'link', 'checkbox', 'radio', 'switch', 'tab', 'menuitem', 'menuitemradio', 'option', 'gridcell', 'combobox', 'textbox', 'searchbox', 'spinbutton']
  const MAX_NAME = 120
  const MAX_VALUE = 120
  // A credential, a one-time code, or a payment detail is never enumerated, so no fast
  // decision can name it and no fast action can read it back. The words are specific
  // ones: a filter that hides a usable field costs a task its fast path, while one that
  // misses a secret is caught by the input type below.
  const SENSITIVE = /(password|passwd|passcode|secret|token|api[-_]?key|\botp\b|one[-_ ]?time|verification[-_ ]?code|recovery[-_ ]?code|cvv|cvc|card[-_ ]?number|credit[-_ ]?card|payment|iban|\bssn\b|private[-_]?key|mnemonic)/i
  const SKIP_TYPES = { password: true, file: true, hidden: true }

  function attr(el, name) {
    try { return el && el.getAttribute ? String(el.getAttribute(name) || '') : '' } catch { return '' }
  }

  /** The role a fast decision acts on, or an empty string for something that is only text. */
  function role(el) {
    const tag = String((el && el.tagName) || '').toLowerCase()
    const type = tag === 'input' ? String(attr(el, 'type') || 'text').toLowerCase() : ''
    if (SKIP_TYPES[type]) return ''
    const explicit = attr(el, 'role').trim().toLowerCase()
    if (explicit && ROLES.indexOf(explicit) >= 0) return explicit
    if (tag === 'a') return attr(el, 'href') ? 'link' : ''
    if (tag === 'button' || tag === 'summary') return 'button'
    if (tag === 'textarea') return 'textbox'
    if (tag === 'select') return el.multiple ? '' : 'combobox'
    if (tag === 'option') return 'option'
    if (tag === 'input') {
      if (type === 'checkbox') return 'checkbox'
      if (type === 'radio') return 'radio'
      if (type === 'search') return 'searchbox'
      if (type === 'number') return 'spinbutton'
      if (type === 'submit' || type === 'button' || type === 'reset' || type === 'image') return 'button'
      if (type === 'range') return 'spinbutton'
      return 'textbox'
    }
    try { if (el.isContentEditable) return 'textbox' } catch {}
    return ''
  }

  /**
   * A field whose value is a secret is not part of the fast path at all. Only fields are
   * withheld: a link or a button that mentions payment is a control like any other, and
   * hiding it would leave the decision unable to report what is on the page.
   */
  function forbidden(el) {
    const tag = String((el && el.tagName) || '').toLowerCase()
    if (tag !== 'input' && tag !== 'textarea') return false
    if (tag === 'input') {
      const type = String(attr(el, 'type') || 'text').toLowerCase()
      if (SKIP_TYPES[type]) return true
    }
    return SENSITIVE.test([attr(el, 'name'), attr(el, 'id'), attr(el, 'autocomplete'), attr(el, 'aria-label'), attr(el, 'placeholder')].join(' '))
  }

  function clip(value, limit) {
    const text = String(value === undefined || value === null ? '' : value).replace(/\s+/g, ' ').trim()
    return text.length > limit ? text.slice(0, limit) : text
  }

  /** The closest thing to an accessible name this page admits, from the cheapest source first. */
  function name(el) {
    const labelled = attr(el, 'aria-label')
    if (labelled) return clip(labelled, MAX_NAME)
    const by = attr(el, 'aria-labelledby')
    if (by) {
      const parts = []
      for (const id of by.split(/\s+/).slice(0, 3)) {
        const node = el.ownerDocument && el.ownerDocument.getElementById ? el.ownerDocument.getElementById(id) : null
        if (node) parts.push(node.textContent || '')
      }
      const text = clip(parts.join(' '), MAX_NAME)
      if (text) return text
    }
    try {
      const labels = el.labels
      if (labels && labels.length) {
        const text = clip(labels[0].textContent || '', MAX_NAME)
        if (text) return text
      }
    } catch {}
    const placeholder = attr(el, 'placeholder')
    const title = attr(el, 'title')
    const alt = attr(el, 'alt')
    if (placeholder) return clip(placeholder, MAX_NAME)
    if (title) return clip(title, MAX_NAME)
    if (alt) return clip(alt, MAX_NAME)
    const tag = String((el.tagName || '')).toLowerCase()
    const type = tag === 'input' ? String(attr(el, 'type') || 'text').toLowerCase() : ''
    if (tag === 'input' && (type === 'submit' || type === 'button' || type === 'reset')) return clip(el.value || '', MAX_NAME)
    if (tag === 'select') {
      const option = el.options && el.options[el.selectedIndex]
      if (option && el.selectedIndex > -1) return clip(option.textContent || '', MAX_NAME)
    }
    // Visible text is a name only while it is short enough to be one: the textContent of a
    // container is not the name of anything. A container is recognised by how many elements it
    // holds, which is what keeps a card's whole paragraph out of the name of its link.
    let children = 0
    try { children = el.querySelectorAll ? el.querySelectorAll('*').length : 0 } catch {}
    const text = children <= 8 ? clip(el.textContent || '', MAX_NAME) : ''
    if (text) return text
    return tag === 'input' || tag === 'textarea' ? clip(el.value || '', MAX_NAME) : ''
  }

  function style(el) {
    const view = el.ownerDocument && el.ownerDocument.defaultView
    return view && view.getComputedStyle ? view.getComputedStyle(el) : null
  }

  /** Whether the page itself is saying this control cannot be used right now. */
  function unavailable(el) {
    if (el.disabled) return 'the control is disabled'
    if (attr(el, 'aria-disabled').toLowerCase() === 'true') return 'the control is disabled'
    if (attr(el, 'aria-hidden').toLowerCase() === 'true') return 'the control is hidden'
    let hidden = null
    try { hidden = el.closest ? el.closest('[hidden],[inert],[aria-hidden="true"]') : null } catch {}
    if (hidden) return 'the control is hidden'
    const computed = style(el)
    if (computed) {
      if (computed.display === 'none') return 'the control is not rendered'
      if (computed.visibility && computed.visibility !== 'visible' && computed.visibility !== 'inherit') return 'the control is not visible'
      if (computed.opacity !== '' && Number(computed.opacity) === 0) return 'the control is transparent'
    }
    let rects = null
    try { rects = el.getClientRects ? el.getClientRects() : null } catch {}
    if (rects && rects.length === 0) return 'the control is not rendered'
    return ''
  }

  /**
   * Where a link goes and which region of the page a control lives in. Both exist to make one
   * offered option distinguishable from another: a choice question's criteria are supposed to
   * separate the options, and two controls whose descriptions are only their own text may be
   * indistinguishable to the model that has to pick one. Only the path is disclosed — never a
   * query string, which can carry a token, and never a selector or a coordinate.
   */
  function destination(el) {
    const tag = String((el && el.tagName) || '').toLowerCase()
    if (tag !== 'a') return ''
    const href = attr(el, 'href')
    if (!href) return ''
    try {
      const url = new URL(href, (el.ownerDocument && el.ownerDocument.location ? el.ownerDocument.location.href : undefined) || 'https://example.invalid/')
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return ''
      return clip(url.pathname + (url.pathname.endsWith('/') ? '' : '/'), 48)
    } catch { return clip(href.split('?')[0], 48) }
  }

  /* The region a control sits in, so two controls with the same name are still told apart. */
  function context(el) {
    let region = null
    try { region = el.closest ? el.closest('nav,header,footer,main,aside,article,form,dialog,section,[role="navigation"],[role="dialog"],[role="search"],[role="banner"],[role="main"],[role="listbox"],[role="menu"],[role="tablist"]') : null } catch {}
    if (!region) return ''
    // The role is what tells one region from another: a listbox is a list of suggestions and a
    // search form is where a query is submitted, while both may be an unlabelled <div>.
    const role = attr(region, 'role').trim().toLowerCase()
    const tag = String((region.tagName || '')).toLowerCase()
    const label = clip(attr(region, 'aria-label'), 32)
    const name = role || tag
    return label ? `${name} "${label}"` : name
  }

  function rectOf(el) {
    let rect = null
    try { rect = el.getBoundingClientRect() } catch {}
    if (!rect) return { x: 0, y: 0, width: 0, height: 0 }
    return { x: Math.round(rect.left), y: Math.round(rect.top), width: Math.round(rect.width), height: Math.round(rect.height) }
  }

  function state(el) {
    const active = el.ownerDocument ? el.ownerDocument.activeElement : null
    const focused = Boolean(active) && (active === el || (el.contains ? el.contains(active) : false))
    const checked = typeof el.checked === 'boolean' ? el.checked : attr(el, 'aria-checked').toLowerCase() === 'true'
    const selected = typeof el.selected === 'boolean' ? Boolean(el.selected) : attr(el, 'aria-selected').toLowerCase() === 'true'
    const expandedRaw = attr(el, 'aria-expanded')
    return {
      disabled: Boolean(el.disabled) || attr(el, 'aria-disabled').toLowerCase() === 'true',
      readonly: Boolean(el.readOnly) || attr(el, 'aria-readonly').toLowerCase() === 'true',
      focused,
      checked,
      selected,
      expanded: expandedRaw === '' ? undefined : expandedRaw.toLowerCase() === 'true',
    }
  }

  function hash(parts) {
    const text = parts.join('\u0001')
    let value = 2166136261
    for (let index = 0; index < text.length; index++) {
      value ^= text.charCodeAt(index)
      value = (value * 16777619) >>> 0
    }
    return value.toString(36)
  }

  /**
   * What makes a control the control a decision meant. It is deliberately semantic — role,
   * name, value, state — and not geometric: a page whose own animation nudges a control by a
   * pixel must not read as a different control, while a page that renamed it must. Geometry
   * is checked where it belongs, by the hit test that decides whether a click can land.
   */
  function fingerprint(el) {
    const flags = state(el)
    return hash([
      role(el), name(el), clip(el.value === undefined ? '' : el.value, MAX_VALUE),
      flags.disabled ? 'disabled' : '', flags.readonly ? 'readonly' : '', flags.checked ? 'checked' : '',
      flags.selected ? 'selected' : '', flags.expanded === undefined ? '' : 'expanded=' + flags.expanded,
    ])
  }

  /** What a person would call the thing a click would have landed on instead. */
  function describe(el) {
    if (!el) return ''
    const pieces = [String(el.tagName || '').toLowerCase()]
    const label = attr(el, 'aria-label') || attr(el, 'title')
    const text = clip(label || el.textContent || '', 60)
    if (text) pieces.push(text)
    return clip(pieces.join(' '), 80)
  }

  /**
   * Performs an action inside the page, for a tab Chrome is not rendering.
   *
   * Injected input never reaches a hidden tab, but the page's own code runs either way, so the
   * action is performed by the page instead: the same events a real input would have produced,
   * dispatched from the page. It is not real user input — `isTrusted` is false and a native
   * control (a canvas, a native picker, anything that reads the browser's own input state) may
   * not respond — which is why the answer says so instead of pretending nothing changed.
   */
  function activateInPage(el, kind, value) {
    const view = el.ownerDocument && el.ownerDocument.defaultView ? el.ownerDocument.defaultView : null
    const opts = { bubbles: true, cancelable: true, ...(view ? { view } : {}) }
    const emit = (target, type, extra) => {
      let event = null
      try {
        const name = type.indexOf('pointer') === 0 ? 'PointerEvent' : type.indexOf('key') === 0 ? 'KeyboardEvent' : 'MouseEvent'
        const Ctor = view && view[name] ? view[name] : (typeof globalThis !== 'undefined' ? globalThis[name] : undefined)
        if (Ctor) event = new Ctor(type, { ...opts, ...(extra || {}) })
      } catch {}
      if (!event) { try { event = new Event(type, opts) } catch {} }
      if (event) { try { target.dispatchEvent(event) } catch {} }
    }
    if (kind === 'click') {
      try { el.scrollIntoView && el.scrollIntoView({ block: 'center', inline: 'center' }) } catch {}
      // The full sequence, so a page listening for any of them sees what a click produces.
      emit(el, 'pointerdown', { button: 0, buttons: 1 })
      emit(el, 'mousedown', { button: 0, buttons: 1, detail: 1 })
      emit(el, 'pointerup', { button: 0, buttons: 0 })
      emit(el, 'mouseup', { button: 0, buttons: 0, detail: 1 })
      // Exactly one click event: the sequence above already carries it, and calling el.click()
      // as well would run the page's handler twice for one action.
      emit(el, 'click', { button: 0, buttons: 0, detail: 1 })
      return true
    }
    if (kind === 'type') {
      try { el.focus({ preventScroll: true }) } catch { try { el.focus() } catch {} }
      const text = String(value === undefined || value === null ? '' : value)
      let wrote = false
      try {
        // A framework tracks its own value: writing through the prototype setter is what a
        // person's keystroke looks like to it, and assigning `el.value` is not.
        const proto = view && view.HTMLTextAreaElement && el instanceof view.HTMLTextAreaElement
          ? view.HTMLTextAreaElement.prototype
          : view && view.HTMLInputElement ? view.HTMLInputElement.prototype : null
        const setter = proto ? Object.getOwnPropertyDescriptor(proto, 'value') : null
        if (setter && setter.set) { setter.set.call(el, text); wrote = true }
      } catch {}
      if (!wrote) { try { el.value = text; wrote = true } catch {} }
      if (!wrote && el.isContentEditable) {
        try { el.textContent = text; wrote = true } catch {}
      }
      emit(el, 'input', {})
      emit(el, 'change', {})
      return wrote
    }
    if (kind === 'scroll') return false
    return false
  }

  // The file input a control stands for, or null. A page hides the input it uploads through, so
  // the control a decision can name is often only a proxy for it: this is what makes an upload
  // addressable through that control, and what tells a click it must not be used instead.
  function fileInputFor(node) {
    if (!node || node.nodeType !== 1) return null
    const isFile = (element) => Boolean(element) && element.tagName === 'INPUT' && String(element.type).toLowerCase() === 'file'
    if (isFile(node)) return node
    if (isFile(node.control)) return node.control
    const label = node.closest ? node.closest('label') : null
    if (label && isFile(label.control)) return label.control
    const inside = node.querySelector ? node.querySelector('input[type=file]') : null
    if (inside) return inside
    // A page often puts the visible control and the hidden input side by side inside one small
    // wrapper — a styled button and the input it opens — with no label relation between them.
    // The nearest ancestor that holds exactly one file input is that wrapper; a container that
    // holds several is ambiguous and is not guessed at, and body/html are never considered, so
    // a button on a page that happens to have a file input somewhere is not an upload control.
    let parent = node.parentElement
    for (let depth = 0; parent && depth < 4; depth += 1, parent = parent.parentElement) {
      const name = String(parent.tagName || '').toLowerCase()
      if (name === 'body' || name === 'html') break
      const inputs = parent.querySelectorAll ? parent.querySelectorAll('input[type=file]') : []
      if (inputs.length === 1) return inputs[0]
      if (inputs.length > 1) break
    }
    if (node.id) {
      const explicit = node.ownerDocument.querySelector('label[for="' + (globalThis.CSS && CSS.escape ? CSS.escape(node.id) : node.id) + '"] input[type=file]')
      if (explicit) return explicit
    }
    return null
  }

  return { attr, role, forbidden, clip, name, style, unavailable, rectOf, state, hash, fingerprint, describe, destination, context, activateInPage, fileInputFor, MAX_NAME, MAX_VALUE, ROLES }
}

/**
 * One pass over the document: the page, the controls a fast decision may act on, and the
 * fingerprint that says whether anything about them moved.
 *
 * Controls that are off screen are still enumerated — a goal can name something below the fold,
 * and the guard brings it into view before it is used — but they are listed after the ones that
 * are already visible, so a step that needs no scrolling does not have to look past a page of
 * controls it cannot see. Text that a page hides is not enumerated at all.
 *
 * Only the main document is enumerated. A control inside another frame would be reported at
 * frame-relative coordinates, and a click dispatched from here lands at viewport
 * coordinates, so guessing the offset is how a click ends up on the wrong control. Frames
 * are counted instead, and the general path — which reads the accessibility tree and
 * resolves every node in its own context — stays responsible for them.
 */
function shunFastCollect(state, options, helpers) {
  const shown = []
  const below = []
  const interactive = 'a[href],button,input,textarea,select,summary,option,[role],[contenteditable=""],[contenteditable="true"]'
  let candidates = []
  try { candidates = document.querySelectorAll(interactive) } catch { candidates = [] }
  const viewport = { width: Math.round(innerWidth || 0), height: Math.round(innerHeight || 0) }
  const view = document.defaultView || window
  let frames = { total: 0, crossOrigin: 0 }
  try {
    const all = document.querySelectorAll('iframe,frame')
    frames.total = all.length
    for (const frame of all) {
      let sameOrigin = true
      try { sameOrigin = Boolean(frame.contentDocument) } catch { sameOrigin = false }
      if (!sameOrigin) frames.crossOrigin += 1
    }
  } catch {}
  state.nodes.clear()
  for (const el of candidates) {
    if (helpers.forbidden(el)) continue
    const role = helpers.role(el)
    if (!role) continue
    if (helpers.unavailable(el)) continue
    const rect = helpers.rectOf(el)
    if (rect.width < 1 || rect.height < 1) continue
    const inView = rect.y + rect.height > 0 && rect.y < viewport.height && rect.x + rect.width > 0 && rect.x < viewport.width
    let id = state.ids.get(el)
    if (id === undefined) { id = state.next; state.next += 1; state.ids.set(el, id) }
    state.nodes.set(id, el)
    const flags = helpers.state(el)
    const name = helpers.name(el)
    const value = helpers.clip(el.value === undefined ? '' : el.value, helpers.MAX_VALUE)
    const target = helpers.destination(el)
    const region = helpers.context(el)
    ;(inView ? shown : below).push({
      id, role, name, value, tag: String((el.tagName || '')).toLowerCase(), rect,
      ...(target ? { target } : {}),
      ...(region ? { region } : {}),
      ...(inView ? {} : { offscreen: true }),
      ...(flags.disabled ? { disabled: true } : {}),
      ...(flags.readonly ? { readonly: true } : {}),
      ...(flags.focused ? { focused: true } : {}),
      ...(flags.checked ? { checked: true } : {}),
      ...(flags.selected ? { selected: true } : {}),
      ...(flags.expanded === undefined ? {} : { expanded: flags.expanded }),
      fingerprint: helpers.fingerprint(el),
    })
  }
  const elements = shown.length >= options.maxElements ? shown.slice(0, options.maxElements) : shown.concat(below.slice(0, options.maxElements - shown.length))
  const text = helpers.clip(String(document.body && document.body.innerText || ''), options.maxText)
  const scrollY = Math.round(view.scrollY || 0)
  const scrollX = Math.round(view.scrollX || 0)
  const documentHeight = Math.max(document.documentElement ? document.documentElement.scrollHeight || 0 : 0, viewport.height)
  const url = String(location.href || '')
  // A document is identified by when its navigation started: a replacement document starts a
  // new one, and every identity the previous page handed out is unknown to it — which is
  // exactly what should happen to a decision made about the page that is gone.
  const marker = String((view.performance && view.performance.timeOrigin) || 0)
  // What makes one page state the same state as another. The controls and their own identities
  // carry it, and the page text enters as both its length and a hash of its opening — the same
  // shape the general path uses. Length alone missed every change that kept the text the same
  // size: a counter, a price, a score, or a status line all read as "nothing changed" and the
  // loop handed back while it was in fact making progress.
  // Controls enter by what they are, never by where they were listed. The ids are handed out
  // per collection, so the same page scrolled by one line renamed every control and read as a
  // changed page — a click that merely brought a control into view was reported as progress and
  // hid a real stall. The scroll offsets are left out for the same reason: moving the viewport
  // is not the page changing, and a page that reveals more when it scrolls has a different
  // control set and a longer text either way.
  const fingerprint = helpers.hash([
    url, marker,
    elements.map(el => el.fingerprint).sort().join(','),
    String(text.length), helpers.hash([text.slice(0, 400)]),
  ])
  return {
    url, title: String(document.title || ''), readyState: String(document.readyState || ''),
    viewport, scroll: { x: scrollX, y: scrollY, max: Math.max(0, documentHeight - viewport.height) },
    text, marker, fingerprint, elements, frames,
  }
}

/**
 * The freshness guard, and the only place a fast action touches the page.
 *
 * A decision was made about a control as the page showed it. Before that decision is acted
 * on, the control has to still be that control: same identity, same role, same name, same
 * value and state, still rendered, still on screen, and still what a click at its own centre
 * would reach. Anything else is stale, and stale means no action and a fresh observation —
 * never a click at a coordinate that used to be right.
 */
function shunFastGuard(state, expected, action, helpers) {
  // Chrome only delivers injected input to a tab it is rendering. A tab created in the
  // background reports hidden, and every click and keystroke sent to it is dropped without an
  // error — which reads as a page that never changes. Reporting it here is what lets the
  // caller show the tab instead of clicking into nothing.
  const visibility = String(document.visibilityState || '')
  // A hidden tab receives no injected input, so the action is performed by the page itself —
  // and reported as such. Nothing is done through the input pipeline on a tab Chrome is not
  // rendering, because nothing would arrive.
  const hidden = Boolean(visibility) && visibility !== 'visible'
  const id = Number(expected.id)
  const el = state.nodes.get(id)
  if (!el || !el.isConnected) return { ok: false, reason: 'gone' }
  const unavailable = helpers.unavailable(el)
  if (unavailable) return { ok: false, reason: 'unavailable', detail: unavailable }
  if (expected.role && helpers.role(el) !== expected.role) return { ok: false, reason: 'changed', detail: 'the control is no longer a ' + expected.role }
  if (expected.name !== undefined && expected.name !== '' && helpers.name(el) !== expected.name) return { ok: false, reason: 'changed', detail: 'the control is no longer named "' + helpers.clip(expected.name, 60) + '"' }
  if (expected.fingerprint && helpers.fingerprint(el) !== expected.fingerprint) return { ok: false, reason: 'changed', detail: 'the control changed on the page' }
  // A control that stands for a file input is not clickable, in any tab state: a page cannot
  // open a file picker by itself, and the upload is a file being set on the input underneath.
  if (action.kind === 'click' && helpers.fileInputFor(el)) return { ok: false, reason: 'file-input' }
  if (hidden) {
    // Identity is what matters here; there is no viewport to land a click in.
    if (action.kind === 'select') {
      const value = String(action.value === undefined ? '' : action.value)
      try { el.value = value } catch { return { ok: false, reason: 'unavailable', detail: 'the page refused that value' } }
      for (const type of ['input', 'change']) { try { el.dispatchEvent(new Event(type, { bubbles: true })) } catch {} }
      return { ok: true, synthetic: true }
    }
    const performed = helpers.activateInPage(el, action.kind, action.text)
    if (!performed) return { ok: false, reason: 'not-visible', detail: 'the tab is hidden and this action cannot be performed by the page' }
    return { ok: true, synthetic: true }
  }
  const doc = el.ownerDocument
  const view = doc.defaultView || window
  const innerWidth = view.innerWidth || 0
  const innerHeight = view.innerHeight || 0
  const whole = (box) => box.width >= 1 && box.height >= 1 && box.top >= 0 && box.left >= 0 && box.bottom <= innerHeight && box.right <= innerWidth
  let rect = el.getBoundingClientRect()
  if (!whole(rect)) {
    // Bringing it into view is what makes the hit test below meaningful, and it is what the
    // general path does before it clicks. It is not a page mutation the user would see.
    try { el.scrollIntoView({ block: 'center', inline: 'center' }) } catch {}
    rect = el.getBoundingClientRect()
  }
  if (rect.width < 1 || rect.height < 1) return { ok: false, reason: 'no-size' }
  // A control does not always occupy one box. An inline link that wraps has one box per line,
  // and the rectangle spanning them has a middle the control itself does not occupy: a click
  // dispatched there reaches whatever lies behind the control, which is indistinguishable from
  // a control that does nothing when it is clicked — the action reports success and the page
  // never moves. Every box the control really occupies is therefore offered to the point-in-
  // front probe, and the first point the probe answers with this control wins.
  let boxes = [rect]
  try {
    const rects = el.getClientRects ? el.getClientRects() : null
    if (rects && rects.length) boxes = Array.from(rects)
  } catch {}
  const canProbe = typeof doc.elementFromPoint === 'function'
  let chosen = null
  let reachable = false
  let covering = ''
  for (const box of boxes) {
    if (box.width < 1 || box.height < 1) continue
    const pointX = Math.round(box.left + box.width / 2)
    const pointY = Math.round(box.top + box.height / 2)
    if (pointX < 0 || pointY < 0 || pointX > innerWidth || pointY > innerHeight) continue
    reachable = true
    let hit = null
    try { hit = canProbe ? doc.elementFromPoint(pointX, pointY) : null } catch {}
    // Whatever is on top of a click point receives the click, so a point inside a child is
    // still a reach — an icon inside a button belongs to that button — while a point that only
    // reaches a parent belongs to that parent, and a click there does not activate this
    // control. Typing and choosing address the control itself rather than a point, so for those
    // a wrapping parent is reachable exactly as it was before.
    const reaches = hit === el || (el.contains && el.contains(hit)) || (action.kind !== 'click' && hit && hit.contains && hit.contains(el))
    if (!canProbe || reaches) { chosen = { x: pointX, y: pointY, box }; break }
    if (!covering && hit) covering = helpers.describe(hit)
  }
  if (!chosen) {
    if (!reachable) return { ok: false, reason: 'offscreen' }
    return { ok: false, reason: 'covered', ...(covering ? { covering } : {}) }
  }
  const x = chosen.x
  const y = chosen.y
  const width = Math.round(chosen.box.width)
  const height = Math.round(chosen.box.height)
  // Verified, so the page-side half of the action may run. Focus is what a click would have
  // done anyway and is not the action itself; a chosen option is the action, and reporting it
  // as unperformed after setting it would be a lie.
  if (action.kind === 'type') {
    try { el.focus({ preventScroll: true }) } catch { try { el.focus() } catch {} }
  } else if (action.kind === 'select') {
    const value = String(action.value === undefined ? '' : action.value)
    try {
      el.value = value
    } catch {
      return { ok: false, reason: 'unavailable', detail: 'the page refused that value' }
    }
    // A page that listens for the change hears about it the way a person's own choice would
    // announce it. A page that cannot dispatch is still holding the value that was chosen.
    for (const type of ['input', 'change']) {
      try { el.dispatchEvent(new Event(type, { bubbles: true })) } catch {}
    }
  }
  return { ok: true, x, y, box: { x: Math.round(chosen.box.left), y: Math.round(chosen.box.top), width, height } }
}

/**
 * The two page expressions, built here so the worker never writes page code itself.
 *
 * Both share one registry, keyed by a name that is part of the wire contract: the
 * observation creates it and the guard resolves identities through it.
 */
const SHUN_FAST_STATE_KEY = '__shunFastPath'
const SHUN_FAST_ELEMENT_LIMIT = 240
const SHUN_FAST_TEXT_LIMIT = 12_000

function shunFastPage(source) {
  const helpers = `(${shunFastHelpers.toString()})()`
  return `(() => {
  try {
    const helpers = ${helpers}
    const state = globalThis['${SHUN_FAST_STATE_KEY}'] || (globalThis['${SHUN_FAST_STATE_KEY}'] = { ids: new WeakMap(), nodes: new Map(), next: 1 })
    ${source}
  } catch (error) { return { error: String(error && error.message ? error.message : error) } }
})()`
}

globalThis.shunFastPath = {
  /** One evaluate: the page, its controls, and the fingerprint that binds a decision to them. */
  observeExpression() {
    return shunFastPage(`return ${shunFastCollect.toString()}(state, ${JSON.stringify({ maxElements: SHUN_FAST_ELEMENT_LIMIT, maxText: SHUN_FAST_TEXT_LIMIT })}, helpers)`)
  },
  /**
   * One evaluate: verify the named control, then take the page-side half of the action.
   * It answers `ok: false` rather than acting when the page has moved on.
   */
  prepareExpression(expected, action) {
    return shunFastPage(`return ${shunFastGuard.toString()}(state, ${JSON.stringify(expected)}, ${JSON.stringify(action)}, helpers)`)
  },
  /** The name the observation and the guard share the page registry under. */
  stateKey: SHUN_FAST_STATE_KEY,
}
