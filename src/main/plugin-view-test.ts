export type PluginViewTestTheme = 'light' | 'dark'
export type PluginViewTestAction =
  | { type: 'click'; selector: string; waitMs?: number }
  | { type: 'fill'; selector: string; value: string; waitMs?: number }

const accentColors: Record<string, string> = {
  blue: '#4c8dff', sky: '#3aa7e8', teal: '#24a59a', mint: '#3fbf8f', amber: '#d7952d',
  orange: '#df7f35', rose: '#d65d73', pink: '#d568a5', violet: '#9272df',
}

export function pluginViewTestThemeTokens(theme: PluginViewTestTheme, accent = 'violet') {
  const dark = theme === 'dark', color = accentColors[accent] || accentColors.violet
  return dark ? {
    accent: color,
    'app-bg': '#141414',
    'sidebar-bg': '#181818',
    'surface-1': '#1b1b1b',
    'surface-2': '#222222',
    'surface-3': '#292929',
    'border-1': '#2d2d2d',
    'border-2': '#3a3a3a',
    'text-1': '#ececec',
    'text-2': '#b7b7b7',
    'text-3': '#888888',
    'text-4': '#666666',
    'hover-bg': '#262626',
    'sidebar-item-selected': '#2c2c2c',
    'code-bg': '#101010',
  } : {
    accent: color,
    'app-bg': '#f5f4f5',
    'sidebar-bg': '#efedef',
    'surface-1': '#ffffff',
    'surface-2': '#f4f3f4',
    'surface-3': '#eceaec',
    'border-1': '#dedbde',
    'border-2': '#cbc7cb',
    'text-1': '#252325',
    'text-2': '#5d595d',
    'text-3': '#817c81',
    'text-4': '#9c979c',
    'hover-bg': '#e9e6e9',
    'sidebar-item-selected': '#dfdcdf',
    'code-bg': '#faf9fa',
  }
}

export function pluginViewTestHarness(viewUrl: string, channel: string, bridgeToken: string, tokens: Record<string, string>) {
  const targetUrl = pluginViewTestFrameUrl(viewUrl, channel)
  const marker = `__shun_plugin_test_bridge__:${bridgeToken}:`
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; frame-src shun-plugin:; script-src 'unsafe-inline'; style-src 'unsafe-inline'"><style>
html,body,iframe{width:100%;height:100%;margin:0;border:0;overflow:hidden}body,iframe{background:${tokens['app-bg']};color:${tokens['text-1']}}
</style></head><body><iframe title="Plugin view under test" sandbox="allow-scripts allow-same-origin"></iframe><script>(()=>{const frame=document.querySelector('iframe'),channel=${JSON.stringify(channel)},marker=${JSON.stringify(marker)};frame.src=${JSON.stringify(targetUrl)};addEventListener('message',event=>{const message=event.data;if(event.source!==frame.contentWindow||!message||message.source!=='shun-plugin'||message.channel!==channel)return;console.info(marker+JSON.stringify(message))})})()</script></body></html>`
}

export function pluginViewTestFrameUrl(viewUrl: string, channel: string) {
  const url = new URL(viewUrl)
  if (url.protocol !== 'shun-plugin:') throw Error('Plugin test view URL must use the isolated plugin protocol.')
  url.searchParams.set('channel', channel)
  return url.href
}

export function pluginViewTestActionScript(action: PluginViewTestAction) {
  const selector = action.selector.trim()
  if (!selector || selector.length > 500) throw Error('Plugin test action selector is missing or too long.')
  if (action.type === 'click') return `(() => {
    const selector = ${JSON.stringify(selector)}, element = document.querySelector(selector)
    if (!(element instanceof HTMLElement)) return { ok: false, type: 'click', selector, error: 'Element not found.' }
    if ('disabled' in element && element.disabled) return { ok: false, type: 'click', selector, error: 'Element is disabled.' }
    element.scrollIntoView({ block: 'center', inline: 'center' }); element.focus(); element.click()
    return { ok: true, type: 'click', selector }
  })()`
  if (action.value.length > 5_000) throw Error('Plugin test fill value is too long.')
  return `(() => {
    const selector = ${JSON.stringify(selector)}, value = ${JSON.stringify(action.value)}, element = document.querySelector(selector)
    if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement)) return { ok: false, type: 'fill', selector, error: 'Editable element not found.' }
    if (element.disabled) return { ok: false, type: 'fill', selector, error: 'Element is disabled.' }
    element.scrollIntoView({ block: 'center', inline: 'center' }); element.focus(); element.value = value
    element.dispatchEvent(new Event('input', { bubbles: true })); element.dispatchEvent(new Event('change', { bubbles: true }))
    return { ok: true, type: 'fill', selector }
  })()`
}

export function pluginViewTestSnapshotScript() {
  return `(() => {
    const text = value => String(value || '').replace(/\\s+/g, ' ').trim()
    const visible = element => { const style = getComputedStyle(element), rect = element.getBoundingClientRect(); return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity || 1) > 0 && rect.width > 0 && rect.height > 0 }
    const controls = Array.from(document.querySelectorAll('a[href],button,input,select,textarea,[role="button"],[role="menuitem"]')).filter(visible).slice(0, 80).map((element, index) => ({
      ref: index + 1,
      tag: element.tagName.toLowerCase(),
      label: text(element.getAttribute('aria-label') || element.getAttribute('title') || element.getAttribute('placeholder') || element.textContent).slice(0, 160),
      id: element.id || undefined,
      test_id: element.getAttribute('data-testid') || undefined,
      disabled: 'disabled' in element ? Boolean(element.disabled) : undefined,
      checked: 'checked' in element ? Boolean(element.checked) : undefined,
    }))
    return {
      title: document.title,
      ready_state: document.readyState,
      viewport: { width: innerWidth, height: innerHeight, device_pixel_ratio: devicePixelRatio },
      document: { width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight },
      text: text(document.body?.innerText).slice(0, 10000),
      presentation: { horizontal_overflow: document.documentElement.scrollWidth > innerWidth + 1 },
      controls,
    }
  })()`
}

export function pluginViewTestMarker(bridgeToken: string) {
  return `__shun_plugin_test_bridge__:${bridgeToken}:`
}
