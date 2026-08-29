(() => {
  const params = new URLSearchParams(location.search), channel = params.get('channel') || '', root = document.getElementById('app')
  const presets = {
    desktop: { width: 1440, height: 900, label: 'Desktop', fluid: true },
    tablet: { width: 768, height: 1024, label: 'Tablet' },
    phone: { width: 390, height: 844, label: 'Mobile' },
  }
  const state = {
    context: null, url: '', draft: '', canGoBack: false, canGoForward: false, loading: false, error: '', resourceRequestId: '',
    viewport: presets.desktop, scale: 1, debugOpen: false, debugTab: 'console', diagnostics: null, debugLoading: false,
    authRequired: null, pending: new Map(), requestSequence: 0, navigationKey: 0, fullscreen: false,
  }
  const icons = {
    back: '<svg viewBox="0 0 24 24"><path d="m15 18-6-6 6-6"/></svg>',
    forward: '<svg viewBox="0 0 24 24"><path d="m9 18 6-6-6-6"/></svg>',
    refresh: '<svg viewBox="0 0 24 24"><path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 5v6h-6"/></svg>',
    loading: '<svg class="loading" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="7.5"/></svg>',
    go: '<svg viewBox="0 0 24 24"><path d="m9 18 6-6-6-6"/></svg>',
    desktop: '<svg viewBox="0 0 24 24"><rect x="3.5" y="4" width="17" height="12" rx="1.5"/><path d="M8 20h8M12 16v4"/></svg>',
    tablet: '<svg viewBox="0 0 24 24"><rect x="5" y="2.5" width="14" height="19" rx="2"/><path d="M11 18.5h2"/></svg>',
    phone: '<svg viewBox="0 0 24 24"><rect x="7" y="2.5" width="10" height="19" rx="2"/><path d="M10.5 5h3M11 18.5h2"/></svg>',
    debug: '<svg viewBox="0 0 24 24"><rect x="3.5" y="4" width="17" height="16" rx="2"/><path d="M3.5 15.5h17M9 12l3-3 3 3"/></svg>',
    fullscreen: '<svg viewBox="0 0 24 24"><path d="M8 4H4v4M16 4h4v4M20 16v4h-4M4 16v4h4"/></svg>',
    fullscreenExit: '<svg viewBox="0 0 24 24"><path d="M4 9h5V4M20 9h-5V4M15 20v-5h5M9 20v-5H4"/></svg>',
    external: '<svg viewBox="0 0 24 24"><path d="M14 4h6v6M20 4l-9 9"/><path d="M18 13v5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h5"/></svg>',
    window: '<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 8h18M9 14h6M12 11v6"/></svg>',
    warning: '<svg viewBox="0 0 24 24"><path d="M12 3 2.8 20h18.4Z"/><path d="M12 9v5M12 17.5h.01"/></svg>',
  }

  function zh() { return state.context?.language === 'zh' }
  function t(en, cn) { return zh() ? cn : en }
  function normalizeUrl(value) {
    let text = String(value || '').trim()
    if (!text) throw new Error(t('Enter an address.', '请输入地址。'))
    if (!/^[a-z][a-z\d+.-]*:\/\//i.test(text)) text = `http://${text}`
    let url
    try { url = new URL(text) } catch { throw new Error(t('Enter a valid web address.', '请输入有效的网页地址。')) }
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error(t('Browser Preview opens HTTP and HTTPS addresses.', 'Browser Preview 支持 HTTP 和 HTTPS 地址。'))
    return url.href
  }

  function request(method, payload = {}) {
    const requestId = `browser-${Date.now()}-${++state.requestSequence}`
    return new Promise((resolve, reject) => {
      state.pending.set(requestId, { resolve, reject })
      parent.postMessage({ source: 'shun-plugin', channel, type: 'request', requestId, method, payload }, '*')
      setTimeout(() => {
        const pending = state.pending.get(requestId)
        if (!pending) return
        state.pending.delete(requestId)
        reject(new Error(t('Browser diagnostics timed out.', '浏览器诊断请求超时。')))
      }, 12_000)
    })
  }

  function applyTheme(context) {
    const light = context?.theme === 'light' || (context?.theme === 'system' && matchMedia('(prefers-color-scheme: light)').matches)
    document.documentElement.dataset.theme = light ? 'light' : 'dark'
    document.documentElement.style.colorScheme = light ? 'light' : 'dark'
    const map = { accent: 'accent', 'app-bg': 'bg', 'surface-1': 'panel', 'surface-2': 'raised', 'surface-3': 'surface', 'border-1': 'line', 'border-2': 'line-strong', 'text-1': 'text', 'text-2': 'text-secondary', 'text-3': 'muted', 'text-4': 'faint' }
    for (const [source, target] of Object.entries(map)) {
      const value = context?.themeTokens?.[source]
      if (value) document.documentElement.style.setProperty(`--${target}`, value)
    }
  }

  function render() {
    // The preview guest is the browser session. Create it once and patch only
    // the surrounding controls so diagnostics cannot accidentally navigate it.
    if (!root.querySelector('.browser-preview')) root.innerHTML = `<section class="browser-preview">
      <header class="toolbar"></header>
      <div id="auth-slot" class="render-slot"></div>
      <main class="stage">
        <div class="device-wrap"><div class="viewport" style="--viewport-width:${presets.desktop.width}px;--viewport-height:${presets.desktop.height}px;--viewport-scale:1">
          <div id="preview-frame" aria-hidden="true"></div>
          <div id="empty-slot" class="render-slot"></div>
          <div id="error-slot" class="render-slot"></div>
        </div></div>
      </main>
      <div id="debug-slot" class="render-slot"></div>
    </section>`
    const shell = root.querySelector('.browser-preview')
    shell.className = `browser-preview ${state.debugOpen ? 'debug-open' : ''} ${state.viewport.fluid ? 'desktop-fluid' : ''}`
    shell.querySelector('.toolbar').innerHTML = `
        <nav class="nav" aria-label="${t('Navigation', '导航')}">
          <button data-action="back" aria-label="${t('Back', '后退')}" title="${t('Back', '后退')}"${!state.canGoBack ? ' disabled' : ''}>${icons.back}</button>
          <button data-action="forward" aria-label="${t('Forward', '前进')}" title="${t('Forward', '前进')}"${!state.canGoForward ? ' disabled' : ''}>${icons.forward}</button>
          <button data-action="refresh" aria-label="${t('Refresh', '刷新')}" title="${t('Refresh', '刷新')}"${!state.url ? ' disabled' : ''}>${icons.refresh}</button>
        </nav>
        <form class="address" id="address-form">
          <input id="address-input" aria-label="${t('Address', '地址')}" autocomplete="off" spellcheck="false" value="${escapeAttr(state.draft)}" placeholder="localhost:3000" />
          <span class="address-actions">
            <button type="submit" aria-label="${t('Preview', '预览')}" title="${t('Preview', '预览')}">${state.loading ? icons.loading : icons.go}</button>
            <button type="button" data-action="external" aria-label="${t('Open in default browser', '在默认浏览器中打开')}" title="${t('Open in default browser', '在默认浏览器中打开')}">${icons.external}</button>
          </span>
        </form>
        <div class="devices" aria-label="${t('Viewport size', '视口尺寸')}">
          ${['desktop', 'tablet', 'phone'].map(name => `<button class="${state.viewport.label === presets[name].label ? 'active' : ''}" data-action="${name}" aria-label="${presets[name].label}" title="${presets[name].label}${presets[name].fluid ? '' : ` · ${presets[name].width} × ${presets[name].height}`}">${icons[name]}</button>`).join('')}
          <button class="debug-toggle ${state.debugOpen ? 'active' : ''}" data-action="debug" aria-label="${t('Page diagnostics', '页面诊断')}" title="${t('Console, network, storage and performance', 'Console、Network、Storage 与 Performance')}">${icons.debug}${errorCount() ? `<i>${Math.min(99, errorCount())}</i>` : ''}</button>
          <button class="fullscreen-toggle ${state.fullscreen ? 'active' : ''}" data-action="fullscreen" aria-label="${state.fullscreen ? t('Restore preview', '还原预览') : t('Maximize in window', '窗口内最大化')}" title="${state.fullscreen ? t('Restore preview', '还原预览') : t('Maximize in window', '窗口内最大化')}">${state.fullscreen ? icons.fullscreenExit : icons.fullscreen}</button>
        </div>
      `
    shell.querySelector('#auth-slot').innerHTML = state.authRequired ? `<aside class="auth-banner">${icons.warning}<span><b>${t('Sign-in required', '需要登录')}</b><small>${t('The agent is paused. Complete sign-in here, then continue debugging.', 'Agent 已暂停。请在此完成登录，然后继续调试。')}</small></span><button data-action="resume-auth">${t("I've signed in", '我已登录')}</button></aside>` : ''
    const wrap = shell.querySelector('.device-wrap'), viewport = shell.querySelector('.viewport')
    wrap.className = `device-wrap ${state.viewport.fluid ? 'fluid' : ''}`
    viewport.className = `viewport ${state.viewport.fluid ? 'fluid' : ''}`
    viewport.style.setProperty('--viewport-width', `${state.viewport.width}px`)
    viewport.style.setProperty('--viewport-height', `${state.viewport.height}px`)
    viewport.style.setProperty('--viewport-scale', state.scale)
    shell.querySelector('#empty-slot').innerHTML = !state.url ? `<div class="empty">${icons.window}<b>${t('No page open', '尚未打开网页')}</b><p>${t('Start a web app or enter any HTTP or HTTPS address above.', '启动 Web 应用，或在上方输入任意 HTTP / HTTPS 地址。')}</p></div>` : ''
    shell.querySelector('#error-slot').innerHTML = state.error ? `<div class="error">${icons.warning}<b>${t('Could not open this address', '无法打开此地址')}</b><p>${escapeHtml(state.error)}</p></div>` : ''
    shell.querySelector('#debug-slot').innerHTML = state.debugOpen ? debugPanel() : ''
    bind()
    syncFrameNavigation()
    requestAnimationFrame(fitViewport)
  }

  function syncFrameNavigation() {
    const frame = root.querySelector('#preview-frame')
    if (!frame) return
    const navigationKey = String(state.navigationKey)
    if (!state.url) {
      frame.dataset.navigationKey = navigationKey
      sendBrowserCommand({ type: 'layout', layout: previewLayout(false) })
      return
    }
    if (frame.dataset.navigationKey === navigationKey) return
    frame.dataset.navigationKey = navigationKey
    sendBrowserCommand({ type: 'navigate', url: state.url, navigationKey })
  }

  function bind() {
    root.querySelector('#address-form')?.addEventListener('submit', event => { event.preventDefault(); navigate(root.querySelector('#address-input').value) })
    root.querySelector('#address-input')?.addEventListener('input', event => { state.draft = event.currentTarget.value })
    root.querySelectorAll('[data-action]').forEach(button => button.addEventListener('click', () => action(button.dataset.action)))
    root.querySelectorAll('[data-tab]').forEach(button => button.addEventListener('click', () => { state.debugTab = button.dataset.tab; render(); void refreshDiagnostics() }))
  }

  function sendBrowserCommand(command) {
    parent.postMessage({ source: 'shun-plugin', channel, type: 'browser.command', command }, '*')
  }

  function previewLayout(visible = Boolean(state.url && !state.error)) {
    const viewport = root.querySelector('.viewport')
    if (!viewport) return { visible: false }
    const rect = viewport.getBoundingClientRect()
    return {
      visible,
      x: rect.left,
      y: rect.top,
      width: state.viewport.fluid ? rect.width : state.viewport.width,
      height: state.viewport.fluid ? rect.height : state.viewport.height,
      scale: state.viewport.fluid ? 1 : state.scale,
    }
  }

  async function applyBrowserEvent(payload) {
    if (payload.url && /^https?:\/\//i.test(payload.url)) { state.url = payload.url; state.draft = payload.url }
    if (typeof payload.loading === 'boolean') state.loading = payload.loading
    if (typeof payload.canGoBack === 'boolean') state.canGoBack = payload.canGoBack
    if (typeof payload.canGoForward === 'boolean') state.canGoForward = payload.canGoForward
    if (typeof payload.fullscreen === 'boolean') state.fullscreen = payload.fullscreen
    if (payload.error) { state.error = payload.error; render(); return }
    if (!payload.loaded || !payload.guestId) { updateToolbar(); return }
    state.loading = false; state.error = ''; updateToolbar()
    try {
      const attached = await request('browser.attach', { url: state.url, guestId: payload.guestId })
      state.authRequired = attached?.authRequired || null
      if (state.debugOpen || state.authRequired) await refreshDiagnostics(false)
    } catch (error) { state.error = error.message || String(error); render() }
  }

  function debugPanel() {
    const tabs = [['console', 'Console'], ['network', 'Network'], ['storage', 'Storage'], ['performance', 'Performance']]
    return `<aside class="debug-panel">
      <header><nav>${tabs.map(([id, label]) => `<button data-tab="${id}" class="${state.debugTab === id ? 'active' : ''}">${label}${tabCount(id) ? `<i>${tabCount(id)}</i>` : ''}</button>`).join('')}</nav><span data-viewport-size>${state.viewport.fluid ? 'Desktop' : `${state.viewport.width} × ${state.viewport.height}`}</span><button data-action="debug-refresh" title="${t('Refresh diagnostics', '刷新诊断')}">${icons.refresh}</button></header>
      <div class="debug-content">${state.debugLoading ? `<p class="debug-empty">${t('Reading page…', '正在读取页面…')}</p>` : diagnosticContent()}</div>
    </aside>`
  }

  function diagnosticContent() {
    const data = state.diagnostics
    if (!data) return `<p class="debug-empty">${t('Open a page to inspect it.', '打开页面后即可检查。')}</p>`
    if (data.auth_required) return `<p class="debug-empty auth">${escapeHtml(data.reason || t('Waiting for sign-in.', '正在等待登录。'))}</p>`
    if (state.debugTab === 'console') {
      const rows = data.console || []
      return rows.length ? `<ol class="diagnostic-list">${rows.map(row => `<li class="level-${escapeAttr(row.level)}"><b>${escapeHtml(row.level)}</b><code>${escapeHtml(row.message)}</code><small>${escapeHtml(sourceLabel(row))}</small></li>`).join('')}</ol>` : `<p class="debug-empty">${t('No console messages.', '暂无 Console 消息。')}</p>`
    }
    if (state.debugTab === 'network') {
      const rows = data.network || []
      return rows.length ? `<ol class="diagnostic-list network">${rows.map(row => `<li><b class="status ${Number(row.status) >= 400 || row.error ? 'bad' : ''}">${escapeHtml(row.status || (row.error ? 'ERR' : '…'))}</b><code title="${escapeAttr(row.url)}">${escapeHtml(shortUrl(row.url))}</code><small>${escapeHtml(`${row.method || ''} · ${row.resourceType || ''}${row.durationMs == null ? '' : ` · ${row.durationMs} ms`}`)}</small></li>`).join('')}</ol>` : `<p class="debug-empty">${t('No network requests captured yet.', '尚未捕获 Network 请求。')}</p>`
    }
    if (state.debugTab === 'storage') return storageContent(data.storage)
    return `<pre>${escapeHtml(JSON.stringify(data.performance || {}, null, 2))}</pre>`
  }

  function storageContent(storage) {
    if (!storage) return `<p class="debug-empty">${t('Storage has not been read.', '尚未读取 Storage。')}</p>`
    const sections = [['localStorage', storage.local], ['sessionStorage', storage.session]]
    return `${sections.map(([label, rows]) => `<section class="storage"><h4>${label}</h4>${rows?.length ? rows.map(row => `<div><b>${escapeHtml(row.key)}</b><code>${escapeHtml(row.value)}</code></div>`).join('') : `<p>${t('Empty', '空')}</p>`}</section>`).join('')}<section class="storage"><h4>Cookies</h4><code>${escapeHtml(storage.cookies || t('Empty', '空'))}</code></section>`
  }

  async function refreshDiagnostics(rerender = true) {
    if (!state.url) return
    state.debugLoading = true
    if (rerender) render()
    try {
      const include = state.debugTab === 'storage' ? ['storage', 'console', 'network'] : state.debugTab === 'performance' ? ['performance', 'console', 'network'] : ['console', 'network']
      state.diagnostics = await request('browser.diagnostics', { include })
      state.authRequired = state.diagnostics?.auth_required ? { reason: state.diagnostics.reason } : null
    } catch (error) { state.error = error.message || String(error) }
    state.debugLoading = false
    render()
  }

  function updateToolbar() {
    const back = root.querySelector('[data-action="back"]'), forward = root.querySelector('[data-action="forward"]'), refresh = root.querySelector('[data-action="refresh"]'), submit = root.querySelector('.address button'), input = root.querySelector('#address-input')
    if (back) back.disabled = !state.canGoBack
    if (forward) forward.disabled = !state.canGoForward
    if (refresh) refresh.disabled = !state.url
    if (submit) submit.innerHTML = state.loading ? icons.loading : icons.go
    if (input && document.activeElement !== input) input.value = state.draft
  }

  function navigate(value) {
    try {
      const url = normalizeUrl(value)
      state.url = url; state.draft = url; state.loading = true; state.error = ''; state.diagnostics = null; state.authRequired = null; state.navigationKey++
      render()
    } catch (error) { state.error = error.message || String(error); render() }
  }

  async function action(name) {
    if (presets[name]) { state.viewport = presets[name]; render(); return }
    if (name === 'debug') { state.debugOpen = !state.debugOpen; render(); if (state.debugOpen) void refreshDiagnostics(); return }
    if (name === 'debug-refresh') { void refreshDiagnostics(); return }
    if (name === 'fullscreen') {
      sendBrowserCommand({ type: 'fullscreen', active: !state.fullscreen })
      return
    }
    if (name === 'external') {
      try { globalThis.open(normalizeUrl(state.draft || state.url), '_blank', 'noopener,noreferrer') }
      catch (error) { state.error = error.message || String(error); render() }
      return
    }
    if (name === 'resume-auth') {
      await request('browser.resume')
      state.authRequired = null; state.diagnostics = null; render(); void refreshDiagnostics()
      return
    }
    if (name === 'refresh' && state.url) { state.loading = true; updateToolbar(); sendBrowserCommand({ type: 'refresh' }); return }
    if (name === 'back' && state.canGoBack) { state.loading = true; updateToolbar(); sendBrowserCommand({ type: 'back' }); return }
    if (name === 'forward' && state.canGoForward) { state.loading = true; updateToolbar(); sendBrowserCommand({ type: 'forward' }) }
  }

  function applyResource(payload) {
    if (payload.viewport?.width && payload.viewport?.height) state.viewport = { width: payload.viewport.width, height: payload.viewport.height, label: payload.viewport.label || 'Custom' }
    if (payload.action) { void action(payload.action); return }
    if (payload.url && payload.url !== state.url) navigate(payload.url)
    else render()
  }

  function fitViewport() {
    const stage = root.querySelector('.stage'), wrap = root.querySelector('.device-wrap')
    if (!stage || !wrap) return
    if (state.viewport.fluid) {
      state.scale = 1
      wrap.style.width = '100%'; wrap.style.height = '100%'
      const viewport = wrap.querySelector('.viewport'); if (viewport) viewport.style.setProperty('--viewport-scale', '1')
      const size = root.querySelector('[data-viewport-size]'); if (size) size.textContent = `${Math.round(stage.clientWidth)} × ${Math.round(stage.clientHeight)}`
      sendBrowserCommand({ type: 'layout', layout: previewLayout() })
      return
    }
    const availableWidth = Math.max(1, stage.clientWidth - 24), availableHeight = Math.max(1, stage.clientHeight - 24)
    state.scale = Math.min(1, availableWidth / state.viewport.width, availableHeight / state.viewport.height)
    wrap.style.width = `${Math.round(state.viewport.width * state.scale)}px`
    wrap.style.height = `${Math.round(state.viewport.height * state.scale)}px`
    const viewport = wrap.querySelector('.viewport'); if (viewport) viewport.style.setProperty('--viewport-scale', state.scale)
    sendBrowserCommand({ type: 'layout', layout: previewLayout() })
  }

  function errorCount() { return (state.diagnostics?.console || []).filter(row => row.level === 'error').length + (state.diagnostics?.network || []).filter(row => Number(row.status) >= 400 || row.error).length }
  function tabCount(id) { return id === 'console' ? (state.diagnostics?.console || []).length : id === 'network' ? (state.diagnostics?.network || []).length : 0 }
  function sourceLabel(row) { return [row.source ? shortUrl(row.source) : '', row.line || ''].filter(Boolean).join(':') }
  function shortUrl(value) { try { const url = new URL(value); return `${url.host}${url.pathname}${url.search}`.slice(0, 100) } catch { return String(value || '').slice(0, 100) } }
  function escapeHtml(value) { return String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]) }
  function escapeAttr(value) { return escapeHtml(value) }

  addEventListener('resize', fitViewport)
  addEventListener('message', event => {
    const message = event.data
    if (!message || message.channel !== channel || message.source !== 'shun-host') return
    if (message.type === 'response') {
      const pending = state.pending.get(message.requestId)
      if (!pending) return
      state.pending.delete(message.requestId)
      if (message.error) pending.reject(new Error(message.error)); else pending.resolve(message.result)
      return
    }
    if (message.type === 'browser.event') { void applyBrowserEvent(message.payload || {}); return }
    if (message.type === 'context') { const initial = !state.context; state.context = message.context; applyTheme(message.context); if (initial && !state.url) render(); return }
    if (message.type === 'event' && message.event === 'resource.open' && message.payload?.url) {
      const requestId = String(message.payload.requestId || '')
      if (requestId && requestId === state.resourceRequestId) return
      state.resourceRequestId = requestId; applyResource(message.payload)
    }
  })

  render()
  parent.postMessage({ source: 'shun-plugin', channel, type: 'ready' }, '*')
})()
