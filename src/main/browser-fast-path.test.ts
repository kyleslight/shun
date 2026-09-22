import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'

/**
 * The fast path's page-side half runs in the page, so it is exercised here against a
 * stub document rather than a real one. What is pinned is the pair of properties the
 * rest of the feature rests on: one expression reports exactly the controls a decision
 * may act on, with identities that survive a re-render, and the guard refuses to act the
 * moment the control it was told about is no longer the one the page shows.
 */

const source = await readFile(new URL('../../resources/browser-use-extension/fast-path.js', import.meta.url), 'utf8')

type Rect = { left?: number; top?: number; width?: number; height?: number }

class StubElement {
  tagName: string
  innerText = ''
  attrs = new Map<string, string>()
  parent: StubElement | null = null
  children: StubElement[] = []
  textContent = ''
  value?: string
  checked?: boolean
  selected?: boolean
  disabled = false
  readOnly = false
  isContentEditable = false
  isConnected = true
  hidden = false
  style: Record<string, string> = {}
  rect: Rect
  /** The boxes the control occupies, when it has more than the one rectangle that spans them. */
  rects: Rect[] | null = null
  ownerDocument!: StubDocument
  labels: StubElement[] = []
  options: Array<{ textContent: string }> = []
  selectedIndex = -1
  multiple = false
  focused = false

  constructor(tag: string, options: { attrs?: Record<string, string>; text?: string; rect?: Rect; rects?: Rect[]; value?: string; style?: Record<string, string>; hidden?: boolean } = {}) {
    this.tagName = tag.toUpperCase()
    for (const [key, value] of Object.entries(options.attrs || {})) this.attrs.set(key, value)
    this.textContent = options.text || ''
    this.rect = options.rect || { left: 0, top: 0, width: 100, height: 20 }
    if (options.rects) this.rects = options.rects
    if (options.value !== undefined) this.value = options.value
    if (options.style) this.style = options.style
    if (options.hidden) this.hidden = true
  }

  getAttribute(name: string) { return this.attrs.has(name) ? this.attrs.get(name)! : null }
  setAttribute(name: string, value: string) { this.attrs.set(name, value) }
  appendChild(child: StubElement) { child.parent = this; child.ownerDocument = this.ownerDocument; this.children.push(child); return child }
  contains(other: StubElement | null) {
    for (let node: StubElement | null = other; node; node = node.parent) if (node === this) return true
    return false
  }
  closest(selector: string) {
    const names = selector.split(',').map(part => part.trim())
    for (let node: StubElement | null = this; node; node = node.parent) {
      if (names.some(name => {
        if (name === '[hidden]') return node.hidden || node.attrs.get('hidden') !== undefined
        if (name === '[inert]') return node.attrs.get('inert') !== undefined
        return node.attrs.get('aria-hidden') === 'true'
      })) return node
    }
    return null
  }
  box(rect: Rect) {
    const left = rect.left || 0
    const top = rect.top || 0
    const width = rect.width || 0
    const height = rect.height || 0
    return { left, top, width, height, right: left + width, bottom: top + height, x: left, y: top }
  }
  getBoundingClientRect() { return this.box(this.rect) }
  getClientRects() {
    if (this.hidden) return []
    // A control that wraps onto several lines has one box per line, and the rectangle that spans
    // them covers ground the control itself does not occupy.
    const boxes = this.rects && this.rects.length ? this.rects : [this.rect]
    return boxes.map(rect => this.box(rect))
  }
  focus() { this.ownerDocument.activeElement = this }
  clicks = 0
  scrollIntoView() { this.scrolledIntoView = true }
  scrolledIntoView = false
  events: string[] = []
  dispatchEvent(event: { type: string }) { this.events.push(event.type); return true }
}

class StubDocument {
  elements: StubElement[] = []
  title = 'Stub page'
  readyState = 'complete'
  visibilityState = 'visible'
  activeElement: StubElement | null = null
  body = new StubElement('body')
  documentElement = new StubElement('html')
  hit: StubElement | null = null
  defaultView!: Record<string, unknown>

  querySelectorAll(selector: string) {
    if (/iframe|frame/.test(selector)) return this.elements.filter(element => element.tagName === 'IFRAME')
    return this.elements
  }
  getElementById(id: string) { return this.elements.find(element => element.getAttribute('id') === id) || null }
  elementFromPoint(x: number, y: number) {
    if (this.hit) return this.hit
    // A browser answers with the topmost element whose own box — one box per line, for a control
    // that wraps — contains the point, which is why a point in the gap between two line boxes
    // reaches whatever lies behind the control rather than the control.
    for (let index = this.elements.length - 1; index >= 0; index--) {
      const element = this.elements[index]
      if (element.hidden) continue
      const boxes = element.getClientRects()
      if (boxes.some(box => x >= box.left && x <= box.right && y >= box.top && y <= box.bottom)) return element
    }
    return null
  }
}

function stubPage(elements: StubElement[], options: { scrollY?: number; scrollHeight?: number; hit?: StubElement | null } = {}) {
  const document = new StubDocument()
  const view = {
    innerWidth: 1_200, innerHeight: 800, scrollX: 0, scrollY: options.scrollY || 0,
    performance: { timeOrigin: 1_700_000_000_000 },
    getComputedStyle: (element: StubElement) => ({
      display: element.hidden ? 'none' : 'block',
      visibility: element.style.visibility || 'visible',
      opacity: element.style.opacity || '1',
    }),
    getSelection: () => null,
  }
  document.defaultView = view
  document.documentElement = Object.assign(new StubElement('html'), { scrollHeight: options.scrollHeight || 2_000 })
  document.hit = options.hit === undefined ? null : options.hit
  for (const element of elements) { element.ownerDocument = document; document.elements.push(element) }
  document.body.ownerDocument = document
  const sandbox = {
    document, window: view, location: { href: 'https://example.test/settings' }, console,
    Event: class { type: string; constructor(type: string) { this.type = type } },
    MouseEvent: class { type: string; constructor(type: string) { this.type = type } },
    PointerEvent: class { type: string; constructor(type: string) { this.type = type } },
    KeyboardEvent: class { type: string; constructor(type: string) { this.type = type } },
    ...view,
  }
  vm.createContext(sandbox)
  vm.runInContext(source, sandbox)
  return { sandbox, document, view }
}

type FastPath = {
  observeExpression(): string
  prepareExpression(expected: Record<string, unknown>, action: Record<string, unknown>): string
  stateKey: string
}
type Observation = {
  error?: string
  url: string
  title: string
  marker: string
  fingerprint: string
  scroll: { x: number; y: number; max: number }
  frames: { total: number; crossOrigin: number }
  text: string
  elements: Array<{ id: number; role: string; name: string; value: string; fingerprint: string; offscreen?: boolean; rect: { width: number; height: number }; disabled?: boolean }>
}

function observe(page: { sandbox: Record<string, any> }): Observation {
  const fast = page.sandbox.shunFastPath as FastPath
  return vm.runInContext(fast.observeExpression(), page.sandbox) as Observation
}

function prepare(page: { sandbox: Record<string, any> }, expected: Record<string, unknown>, action: Record<string, unknown>) {
  const fast = page.sandbox.shunFastPath as FastPath
  return vm.runInContext(fast.prepareExpression(expected, action), page.sandbox) as { ok: boolean; synthetic?: boolean; reason?: string; detail?: string; covering?: string; x?: number; y?: number }
}

function clickable(tag: string, name: string, options: { attrs?: Record<string, string>; text?: string; rect?: Rect; rects?: Rect[]; value?: string; style?: Record<string, string>; hidden?: boolean } = {}) {
  return new StubElement(tag, { ...options, attrs: { 'aria-label': name, ...options.attrs }, text: options.text || name })
}

test('one expression reports the controls a decision may act on, and nothing else', () => {
  const button = clickable('button', 'Save')
  const link = new StubElement('a', { attrs: { href: '/issues' }, text: 'Issues' })
  const search = new StubElement('input', { attrs: { type: 'search', placeholder: 'Search' } })
  const password = new StubElement('input', { attrs: { type: 'password', 'aria-label': 'Password' } })
  const card = new StubElement('input', { attrs: { name: 'card-number', 'aria-label': 'Card number' } })
  const disabled = new StubElement('button', { attrs: { 'aria-label': 'Publish' } })
  disabled.disabled = true
  const hidden = new StubElement('button', { attrs: { 'aria-label': 'Hidden action' }, hidden: true })
  const behindHidden = new StubElement('button', { attrs: { 'aria-label': 'Menu item' } })
  const ariaHiddenParent = new StubElement('div', { attrs: { 'aria-hidden': 'true' } })
  const zero = new StubElement('button', { attrs: { 'aria-label': 'Ghost' }, rect: { width: 0, height: 0 } })
  const offscreen = new StubElement('button', { attrs: { 'aria-label': 'Way below' }, rect: { top: 6_000, width: 120, height: 30 } })
  const frame = new StubElement('iframe', { attrs: { src: 'https://other.test' } })
  const page = stubPage([button, link, search, password, card, disabled, hidden, behindHidden, ariaHiddenParent, zero, offscreen, frame])
  ariaHiddenParent.appendChild(behindHidden)

  const first = observe(page)
  assert.equal(first.error, undefined)
  assert.equal(first.url, 'https://example.test/settings')
  assert.equal(first.title, 'Stub page')
  assert.equal(first.scroll.max, 1_200)
  assert.deepEqual(JSON.parse(JSON.stringify(first.frames)), { total: 1, crossOrigin: 1 })
  const named = Array.from(first.elements, element => `${element.role}:${element.name}`)
  // A control below the fold is still offered — a goal can name it, and the guard brings it
  // into view before it is used — but it is offered after everything already on screen.
  assert.deepEqual(named, ['button:Save', 'link:Issues', 'searchbox:Search', 'button:Way below'])
  assert.deepEqual(Array.from(first.elements, element => element.offscreen === true), [false, false, false, true])
  // A secret is never named, and neither is an unrendered control: the observation is what a
  // decision may act on, not an inventory of the page.
  assert.ok(!JSON.stringify(first.elements).includes('Password'))
  assert.ok(!JSON.stringify(first.elements).includes('Card number'))
  assert.ok(!JSON.stringify(first.elements).includes('Hidden action'))
  assert.ok(!JSON.stringify(first.elements).includes('Ghost'))
  assert.equal(typeof first.text, 'string')

  // A re-render keeps a control's identity: the identity belongs to the node, not to a
  // position in the list, which is what lets a decision survive a re-render.
  const again = observe(page)
  assert.deepEqual(Array.from(again.elements, element => element.id), Array.from(first.elements, element => element.id))
  assert.equal(again.fingerprint, first.fingerprint)

  // …and the fingerprint moves the moment something about the page's controls does.
  button.textContent = 'Save changes'
  button.attrs.delete('aria-label')
  assert.notEqual(observe(page).fingerprint, first.fingerprint)
})

test('the guard refuses a control that is no longer the one the decision named', () => {
  const button = clickable('button', 'Continue')
  const overlay = new StubElement('div', { attrs: { 'aria-label': 'Cookie banner' } })
  const page = stubPage([button, overlay])
  const observed = observe(page)
  const target = observed.elements[0]
  const expected = { id: target.id, role: target.role, name: target.name, fingerprint: target.fingerprint }

  // A click lands where the point is, so the control has to be what is at its own centre.
  page.document.hit = overlay
  const covered = prepare(page, expected, { kind: 'click' })
  assert.equal(covered.ok, false)
  assert.equal(covered.reason, 'covered')
  assert.match(covered.covering || '', /div Cookie banner/)

  page.document.hit = button
  const reached = prepare(page, expected, { kind: 'click' })
  assert.equal(reached.ok, true)
  assert.equal(reached.x, 50)
  assert.equal(reached.y, 10)

  // The page replaced the control: the identity it handed out is gone, and no click may be
  // dispatched at the coordinates that used to be right.
  button.isConnected = false
  assert.equal(prepare(page, expected, { kind: 'click' }).reason, 'gone')

  // A control that was renamed is a different control even while it is still on screen.
  const renamed = clickable('button', 'Continue')
  const second = stubPage([renamed])
  const stale = observe(second).elements[0]
  renamed.textContent = 'Delete everything'
  renamed.attrs.delete('aria-label')
  renamed.attrs.set('aria-label', 'Delete everything')
  const changed = prepare(second, { id: stale.id, role: stale.role, name: stale.name, fingerprint: stale.fingerprint }, { kind: 'click' })
  assert.equal(changed.ok, false)
  assert.equal(changed.reason, 'changed')

  // A control disabled after the decision was made is not clicked either.
  const third = stubPage([clickable('button', 'Submit')])
  const before = observe(third).elements[0]
  third.document.elements[0].disabled = true
  const disabled = prepare(third, { id: before.id, role: before.role, name: before.name, fingerprint: before.fingerprint }, { kind: 'click' })
  assert.equal(disabled.ok, false)
  assert.equal(disabled.reason, 'unavailable')
  assert.match(disabled.detail || '', /disabled/)

  // A control the page moved off screen is brought back into view before it is measured,
  // and only then is its position used. It has to have been observable first, because the
  // observation is what a decision is allowed to name.
  const mover = stubPage([clickable('button', 'Next', { rect: { top: 1_000, width: 100, height: 20 } })])
  const moving = observe(mover).elements[0]
  assert.equal(moving.role, 'button')
  mover.document.elements[0].rect = { top: 2_400, width: 100, height: 20 }
  const gate = prepare(mover, { id: moving.id, role: moving.role, name: moving.name, fingerprint: moving.fingerprint }, { kind: 'click' })
  assert.equal(gate.ok, false, 'a control outside the viewport is not clicked at coordinates the browser cannot reach')
  assert.equal(gate.reason, 'offscreen')
  assert.equal(mover.document.elements[0].scrolledIntoView, true)
})

test('a guard that passes takes the page-side half of the action it verified', () => {
  const select = new StubElement('select', { attrs: { 'aria-label': 'Sort' } })
  select.value = 'newest'
  const page = stubPage([select])
  const observed = observe(page)
  const target = observed.elements[0]
  assert.equal(target.role, 'combobox')
  assert.equal(target.value, 'newest')
  const gate = prepare(page, { id: target.id, role: target.role, name: target.name, fingerprint: target.fingerprint }, { kind: 'select', value: 'oldest' })
  assert.equal(gate.ok, true)
  assert.equal(select.value, 'oldest')
  assert.deepEqual(select.events, ['input', 'change'])

  // Typing is prepared, never performed here: the text is inserted by the browser so the
  // page receives the same input events a person's keyboard would produce.
  const field = new StubElement('input', { attrs: { 'aria-label': 'Repository' } })
  const typing = stubPage([field])
  const fieldTarget = observe(typing).elements[0]
  const focus = prepare(typing, { id: fieldTarget.id, role: fieldTarget.role, name: fieldTarget.name, fingerprint: fieldTarget.fingerprint }, { kind: 'type' })
  assert.equal(focus.ok, true)
  assert.equal(typing.document.activeElement, field)
  assert.equal(field.value, undefined)

  // An identity from a page that has been replaced resolves to nothing at all, because the
  // registry that issued it does not exist any more.
  const gone = prepare(page, { id: 999, role: 'button' }, { kind: 'click' })
  assert.equal(gone.ok, false)
  assert.equal(gone.reason, 'gone')
})

test('a control that wraps onto several lines is clicked at a point it really occupies', () => {
  // The rectangle that spans a wrapped inline link reaches over the gap between its line boxes,
  // and the middle of that rectangle is a point the link does not occupy: a click there lands on
  // whatever is behind the link, the action reports success, and the page never moves. The guard
  // therefore needs a point the point-in-front probe answers with the link itself.
  const heading = new StubElement('h3', { rect: { left: 10, top: 300, width: 200, height: 44 } })
  const link = clickable('a', 'Princess Jellyfish', {
    attrs: { href: '/catalogue/princess-jellyfish/index.html' },
    rect: { left: 10, top: 300, width: 200, height: 44 },
    rects: [{ left: 10, top: 300, width: 180, height: 20 }, { left: 10, top: 324, width: 60, height: 20 }],
  })
  const page = stubPage([heading, link])
  link.parent = heading
  const target = observe(page).elements.find(element => element.role === 'link')
  assert.ok(target, 'the link is what a decision may name')
  // The middle of the spanning rectangle is between the two lines, so it is the heading that a
  // click there would reach.
  assert.equal(page.document.elementFromPoint(110, 322), heading)
  const gate = prepare(page, { id: target.id, role: target.role, name: target.name, fingerprint: target.fingerprint }, { kind: 'click' })
  assert.equal(gate.ok, true)
  assert.equal(gate.x, 100, 'the point comes from a box the link really occupies')
  assert.equal(gate.y, 310)

  // A control with no box a point can reach is refused rather than clicked at a point that would
  // activate something else.
  const covered = clickable('a', 'Covered link', {
    attrs: { href: '/catalogue/covered/index.html' },
    rect: { left: 10, top: 300, width: 200, height: 44 },
    rects: [{ left: 10, top: 300, width: 180, height: 20 }, { left: 10, top: 324, width: 60, height: 20 }],
  })
  const banner = new StubElement('div', { attrs: { 'aria-label': 'Cookie banner' }, rect: { left: 0, top: 280, width: 600, height: 120 } })
  const blockedPage = stubPage([heading, covered, banner])
  covered.parent = heading
  const blockedTarget = observe(blockedPage).elements.find(element => element.role === 'link')
  assert.ok(blockedTarget)
  const refused = prepare(blockedPage, { id: blockedTarget.id, role: blockedTarget.role, name: blockedTarget.name, fingerprint: blockedTarget.fingerprint }, { kind: 'click' })
  assert.equal(refused.ok, false)
  assert.equal(refused.reason, 'covered')
  assert.match(refused.covering || '', /Cookie banner/)
})

test('the fingerprint follows the controls, not where they were listed or how far the page is scrolled', () => {
  // The ids are handed out per collection, so hashing them made the same page read as changed
  // when a click merely scrolled a control into view — a false "progress" that hid a real stall.
  const first = clickable('button', 'Continue')
  const second = clickable('button', 'Cancel')
  const page = stubPage([first, second])
  const before = observe(page)
  page.view.scrollY = 400
  page.document.elements.reverse()
  const after = observe(page)
  assert.equal(after.fingerprint, before.fingerprint)

  // A page that really changed still reads as changed.
  second.textContent = 'Cancel everything'
  second.attrs.set('aria-label', 'Cancel everything')
  assert.notEqual(observe(page).fingerprint, before.fingerprint)
})

test('a tab Chrome is not rendering is acted on by the page itself, and says so', () => {
  // Injected input never arrives in a hidden tab, but the page's own code runs either way: the
  // guard performs the action from inside the page and marks the answer as page-performed.
  const button = clickable('button', 'Continue')
  const page = stubPage([button])
  const observed = observe(page)
  const target = observed.elements[0]
  const expected = { id: target.id, role: target.role, name: target.name, fingerprint: target.fingerprint }

  page.document.visibilityState = 'hidden'
  const performed = prepare(page, expected, { kind: 'click' })
  assert.equal(performed.ok, true)
  assert.equal(performed.synthetic, true, 'the answer says the page did it, not the input pipeline')
  assert.ok(button.events.includes('mousedown'), 'the sequence a real click produces')
  // One action is one click: the page's own handler must not run twice.
  assert.equal(button.events.filter(event => event === 'click').length, 1)

  // Typing writes through the page too, and tells the framework about it.
  const field = new StubElement('input', { attrs: { 'aria-label': 'Repository' } })
  const typing = stubPage([field])
  const fieldTarget = observe(typing).elements[0]
  typing.document.visibilityState = 'hidden'
  const typed = prepare(typing, { id: fieldTarget.id, role: fieldTarget.role, name: fieldTarget.name, fingerprint: fieldTarget.fingerprint }, { kind: 'type', text: 'shun' })
  assert.equal(typed.ok, true)
  assert.equal(typed.synthetic, true)
  assert.equal(field.value, 'shun')
  assert.deepEqual(field.events, ['input', 'change'])

  // A tab being rendered keeps the real path: coordinates, no synthetic claim.
  page.document.visibilityState = 'visible'
  const real = prepare(page, expected, { kind: 'click' })
  assert.equal(real.ok, true)
  assert.equal(real.synthetic, undefined)
  assert.equal(typeof real.x, 'number')
})

test('the fingerprint moves when the page text changes without changing size', () => {
  // A counter, a price, a score, and a status line all change while the text stays the same
  // length. Hashing only the length read all of them as "nothing changed", which is what made
  // the loop hand back while it was making progress.
  const button = clickable('button', 'Add')
  const page = stubPage([button])
  page.document.body.innerText = 'Counter 0 Add'
  const before = observe(page).fingerprint
  page.document.body.innerText = 'Counter 1 Add'
  assert.notEqual(observe(page).fingerprint, before, 'same length, different text is a different state')
  page.document.body.innerText = 'Counter 2 Add'
  assert.notEqual(observe(page).fingerprint, before)
})

test('a container keeps its contents out of the name of the control inside it', () => {
  // The name has to stay a name: a card whose whole paragraph is its textContent is not what
  // the link inside it is called, and sending that paragraph per control is what made the
  // state bigger than the accessibility tree on a control-dense page.
  const label = new StubElement('span', { text: 'Code' })
  const link = new StubElement('a', { attrs: { href: '/code' } })
  link.appendChild(label)
  for (let index = 0; index < 9; index += 1) link.appendChild(new StubElement('span', { text: 'x' }))
  const plain = new StubElement('a', { attrs: { href: '/issues' }, text: 'Issues' })
  const page = stubPage([link, plain])
  const observed = observe(page)
  const named = Array.from(observed.elements, element => `${element.name}`).sort()
  // The container has no name of its own, and the plain link keeps the one it has.
  assert.deepEqual(named, ['', 'Issues'])
  // The container's contents never became a name (the fingerprint is a base36 hash, so the
  // check is on names, not on the row).
  assert.ok(Array.from(observed.elements, element => element.name || '').every(name => !name.includes('x')))
  // A long accessible name is clipped to the bounded length the state is allowed to carry.
  const windy = new StubElement('button', { attrs: { 'aria-label': 'y'.repeat(300) } })
  const clipped = observe(stubPage([windy])).elements[0].name
  assert.equal(clipped.length, 120)
})
