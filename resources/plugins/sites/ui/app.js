(() => {
  const channel = new URLSearchParams(location.search).get('channel') || ''
  const root = document.getElementById('app')
  const pending = new Map()
  let sequence = 0
  const state = {
    context: null, status: null, loading: true, busy: '', error: '', notice: '', noticeUrl: '',
    publishOpen: false, candidates: null, expanded: '', confirmDelete: '', theme: '',
  }

  const icons = {
    refresh: '<svg viewBox="0 0 24 24"><path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 5v6h-6"/></svg>',
    upload: '<svg viewBox="0 0 24 24"><path d="M12 16V5"/><path d="m8.5 8.5 3.5-3.5 3.5 3.5"/><path d="M5 15v3a1.5 1.5 0 0 0 1.5 1.5h11A1.5 1.5 0 0 0 19 18v-3"/></svg>',
    globe: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17"/><path d="M12 3.5c2.2 2.4 3.3 5 3.3 8.5S14.2 18.1 12 20.5c-2.2-2.4-3.3-5-3.3-8.5S9.8 5.9 12 3.5Z"/></svg>',
    copy: '<svg viewBox="0 0 24 24"><rect x="8" y="8" width="11" height="11" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/></svg>',
    open: '<svg viewBox="0 0 24 24"><path d="M14 4h6v6M20 4l-9 9"/><path d="M18 13v6H5V6h6"/></svg>',
    chevron: '<svg class="small" viewBox="0 0 24 24"><path d="m9 6 6 6-6 6"/></svg>',
    check: '<svg class="small" viewBox="0 0 24 24"><path d="m5 12 4 4L19 6"/></svg>',
    cloud: '<svg viewBox="0 0 24 24"><path d="M7 18h10a3.5 3.5 0 0 0 .4-7A5 5 0 0 0 8 10.4A3.8 3.8 0 0 0 7 18Z"/></svg>',
    alert: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"/><path d="M12 8v5M12 16h.01"/></svg>',
  }

  function request(method, payload = {}) {
    const requestId = `${Date.now()}-${++sequence}`
    parent.postMessage({ source: 'shun-plugin', channel, type: 'request', requestId, method, payload }, '*')
    return new Promise((resolve, reject) => pending.set(requestId, { resolve, reject }))
  }

  addEventListener('message', event => {
    const message = event.data
    if (!message || message.channel !== channel || message.source !== 'shun-host') return
    if (message.type === 'response') {
      const waiter = pending.get(message.requestId)
      if (!waiter) return
      pending.delete(message.requestId)
      if (message.error) waiter.reject(new Error(message.error))
      else waiter.resolve(message.result)
      return
    }
    if (message.type === 'context') {
      state.context = message.context
      applyTheme(message.context)
      render()
    }
  })

  // The host sends its context — theme tokens, language, workspace — only after
  // the view announces itself. Without this the panel runs on fallback colors.
  parent.postMessage({ source: 'shun-plugin', channel, type: 'ready' }, '*')

  function t(en, zh) { return state.context?.language === 'zh' ? zh : en }

  function applyTheme(context) {
    const light = context?.theme === 'light' || (context?.theme === 'system' && matchMedia('(prefers-color-scheme: light)').matches)
    document.documentElement.dataset.theme = light ? 'light' : 'dark'
    document.documentElement.style.colorScheme = light ? 'light' : 'dark'
    const map = {
      'app-bg': 'bg', 'surface-1': 'surface-1', 'surface-2': 'surface-2', 'surface-3': 'surface-3',
      'border-1': 'border-1', 'border-2': 'border-2', 'text-1': 'text-1', 'text-2': 'text-2',
      'text-3': 'text-3', 'text-4': 'text-4', 'accent': 'accent', 'hover-bg': 'hover', 'code-bg': 'code-bg',
    }
    for (const [source, target] of Object.entries(map)) {
      const value = context?.themeTokens?.[source]
      if (value) document.documentElement.style.setProperty(`--${target}`, value)
    }
  }

  const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character])
  const errorText = error => (error instanceof Error ? error.message : String(error)) || t('Something went wrong.', '出了点问题。')

  function formatBytes(bytes) {
    const value = Number(bytes || 0)
    if (value < 1024) return `${value} B`
    if (value < 1024 * 1024) return `${(value / 1024).toFixed(value < 10 * 1024 ? 1 : 0)} KB`
    return `${(value / (1024 * 1024)).toFixed(value < 10 * 1024 * 1024 ? 1 : 0)} MB`
  }

  function relativeTime(timestamp) {
    const seconds = Math.max(0, Math.round((Date.now() - Number(timestamp || 0)) / 1000))
    if (seconds < 60) return t('just now', '刚刚')
    if (seconds < 3600) return t(`${Math.round(seconds / 60)} min ago`, `${Math.round(seconds / 60)} 分钟前`)
    if (seconds < 86_400) return t(`${Math.round(seconds / 3600)} h ago`, `${Math.round(seconds / 3600)} 小时前`)
    return new Date(Number(timestamp)).toLocaleDateString()
  }

  const visibilityLabel = value => value === 'password' ? t('Password', '密码') : value === 'off' ? t('Paused', '已暂停') : t('Public', '公开')

  /** Asked for only when the publish form is opened, so opening the panel stays quick. */
  async function loadCandidates() {
    try { state.candidates = await request('sites.candidates') } catch (error) { state.error = errorText(error) }
  }

  async function refresh(silent = false) {
    if (!silent) { state.loading = true; render() }
    try {
      state.status = await request('sites.status')
      state.error = ''
    } catch (error) { state.error = errorText(error) } finally { state.loading = false; render() }
  }

  /** Every mutation runs through here so the panel shows one honest status line. */
  async function act(label, run) {
    state.busy = label; state.error = ''
    render()
    try {
      const result = await run()
      return result
    } catch (error) {
      state.error = errorText(error)
      return undefined
    } finally {
      state.busy = ''
      render()
    }
  }

  async function publish() {
    const path = document.getElementById('publish-path')?.value || ''
    const visibility = document.getElementById('publish-visibility')?.value || 'public'
    const result = await act(t('Publishing…', '正在发布…'), () => request('sites.publish', { path, visibility }))
    if (!result) { await refresh(true); return }
    state.publishOpen = false
    await refresh(true)
  }

  function render() {
    const status = state.status
    if (!status || state.loading) return void (root.innerHTML = shell(skeleton()))
    if (!status) return void (root.innerHTML = shell(`<div class="state"><span class="glyph">${icons.alert}</span><h2>${t('Sites is unavailable', 'Sites 不可用')}</b><p>${escapeHtml(state.error || t('Try again in a moment.', '请稍后重试。'))}</p><div class="actions"><button class="action" data-action="refresh">${t('Try again', '重试')}</button></div></div>`))
    if (status.blocker) return void (root.innerHTML = shell(blocked(status), statusSum(status)))
    root.innerHTML = shell(ready(status), statusSum(status))
  }

  /** Publishing needs a reachable service, a verified identity, and a workspace to read. */
  function canPublish() {
    const status = state.status
    return Boolean(status && status.available !== false && status.verified !== false && status.workspace)
  }

  function statusSum(status) {
    const sites = status?.sites || []
    if (!status?.domain) return t('Sites', 'Sites')
    return `${sites.length}${t(sites.length === 1 ? ' site' : ' sites', ' 个站点')} · ${escapeHtml(status.domain)}`
  }

  function shell(body, summary) {
    return `<section class="sites">
      <header class="toolbar">
        <h1>${t('Sites', 'Sites')}</h1>
        <span class="count">${summary || ''}</span>
        <span class="spacer"></span>
        <button class="icon-button" data-action="refresh" aria-label="${t('Refresh', '刷新')}" title="${t('Refresh', '刷新')}">${icons.refresh}</button>
        ${canPublish() ? `<button class="button primary" data-action="toggle-publish" ${state.busy ? 'disabled' : ''}>${icons.upload}${t('Publish', '发布')}</button>` : ''}
      </header>
      <div class="body">${body}</div>
      ${notices()}
    </section>`
  }

  /** Shown before the first round trip finishes, so the panel is never a blank wait. */
  function skeleton() {
    return `<div class="skeleton">
      <div class="skeleton-row"><div class="skeleton-bar short"></div><div class="skeleton-bar"></div></div>
      <div class="skeleton-row"><div class="skeleton-bar short"></div><div class="skeleton-bar"></div></div>
      <div class="skeleton-row"><div class="skeleton-bar short"></div><div class="skeleton-bar"></div></div>
    </div>`
  }

  /** Progress and failure only. Success is visible in the panel itself. */
  function notices() {
    if (state.busy) return `<div class="notice progress" role="status" aria-live="polite"><i class="spinner"></i><span>${escapeHtml(state.busy)}</span></div>`
    if (state.error) return `<button class="notice error" data-action="dismiss-error">${escapeHtml(state.error)}</button>`
    return ''
  }

  function blocked(status) {
    if (status.verified === false) {
      // Verification is a short conversation, not a form: the panel explains, the
      // conversation does it.
      return `<div class="state">${icons.globe}
        <h2>${t('Verify an email address to publish', '先验证一个邮箱再发布')}</h2>
        <p>${t('Publishing is tied to a verified email address, so an address stays yours and can be taken down by you. Ask in the conversation and it takes one code.', '发布权绑定在已验证的邮箱上，这样地址归你所有、也只有你能下线。在对话里说一句，输入一次验证码即可。')}</p>
      </div>`
    }
    return `<div class="state">${icons.cloud}
      <h2>${t('Publishing is unavailable', '发布暂不可用')}</h2>
      <p>${escapeHtml(status.blocker || '')}</p>
    </div>`
  }

  function ready(status) {
    const sites = status.sites || []
    const candidates = state.candidates
    const paths = candidates ? candidates.paths : []
    const form = state.publishOpen ? `<div class="card">
      <header>${t('Publish a project', '发布项目')}</header>
      <div class="content">
        <div class="field">
          <label for="publish-path">${t('Folder to publish', '要发布的目录')}</label>
          ${paths.length
            ? `<select id="publish-path">${paths.map(path => `<option value="${escapeHtml(path)}">${escapeHtml(path)}</option>`).join('')}</select>`
            : `<input id="publish-path" placeholder="dist" spellcheck="false" />`}
        </div>
        <div class="field row">
          <div class="field"><label for="publish-visibility">${t('Visibility', '可见性')}</label>
            <select id="publish-visibility">
              <option value="public">${t('Public', '公开')}</option>
              <option value="password">${t('Password', '密码')}</option>
              <option value="off">${t('Paused', '暂停')}</option>
            </select>
          </div>
          <div></div>
        </div>
        <p class="hint">${candidates?.buildScript ? `${t('Build first if needed', '如需先构建')}: ${escapeHtml(candidates.buildScript)}. ` : ''}${t('Only changed files are uploaded, and the address is kept.', '只上传变化的文件，地址保持不变。')}</p>
        <div class="actions">
          <button class="button primary" data-action="publish" ${state.busy ? 'disabled' : ''}>${icons.upload}${t('Publish now', '立即发布')}</button>
          <button class="button outline" data-action="toggle-publish">${t('Cancel', '取消')}</button>
        </div>
      </div>
    </div>` : ''
    const list = sites.length
      ? `<div class="list">${sites.map(siteRow).join('')}</div>`
      : `<div class="state"><span class="glyph">${icons.globe}</span><h2>${t('Nothing published yet', '还没有发布任何站点')}</b><p>${t('Build the project, then publish its output folder. The address is assigned automatically under', '先构建项目，然后发布输出目录；地址会在该域名下自动分配：')} ${escapeHtml(status.domain)}.</p></div>`
    return form + list
  }

  function siteRow(site) {
    const open = state.expanded === site.name
    const armed = state.confirmDelete === site.name
    const host = String(site.url || '').replace(/^https?:\/\//, '').replace(/\/$/, '')
    return `<article class="site-card${open ? ' open' : ''}">
      <div class="card-head">
        <span class="glyph">${escapeHtml((site.title || site.name || '?').trim().charAt(0) || '?')}</span>
        <span class="site-name">
          <b>${escapeHtml(site.title || site.name)}</b>
          <a href="${escapeHtml(site.url)}" data-action="open" data-name="${escapeHtml(site.name)}">${escapeHtml(host)}</a>
        </span>
        <span class="badge ${site.visibility}">${visibilityLabel(site.visibility)}</span>
      </div>
      <div class="card-foot">
        <span class="meta">${site.files} ${t('files', '个文件')} · ${formatBytes(site.bytes)} · ${relativeTime(site.publishedAt)}</span>
        <button class="button outline small" data-action="copy-url" data-url="${escapeHtml(site.url)}">${state.copiedUrl === site.url ? icons.check : icons.copy}${state.copiedUrl === site.url ? t('Copied', '已复制') : t('Copy', '复制')}</button>
        <button class="button outline small" data-action="toggle-site" data-name="${escapeHtml(site.name)}" aria-expanded="${open}">${t('Manage', '管理')}${icons.chevron}</button>
      </div>
      ${open ? `<div class="site-manage">
        <div class="segmented">
          <button data-action="visibility" data-name="${escapeHtml(site.name)}" data-visibility="public" class="${site.visibility === 'public' ? 'active' : ''}" ${state.busy ? 'disabled' : ''}>${t('Public', '公开')}</button>
          <button data-action="visibility" data-name="${escapeHtml(site.name)}" data-visibility="password" class="${site.visibility === 'password' ? 'active' : ''}" ${state.busy ? 'disabled' : ''}>${t('Password', '密码')}</button>
          <button data-action="visibility" data-name="${escapeHtml(site.name)}" data-visibility="off" class="${site.visibility === 'off' ? 'active' : ''}" ${state.busy ? 'disabled' : ''}>${t('Paused', '暂停')}</button>
        </div>
        ${state.revealedPassword?.name === site.name ? `<p class="revealed">${t('Password (shown once)', '密码（仅显示一次）')}: <code>${escapeHtml(state.revealedPassword.password)}</code></p>` : ''}
        ${site.visibility === 'password' ? `<div class="password-row">
          <input id="password-${escapeHtml(site.name)}" type="password" autocomplete="new-password" placeholder="${t('New password', '新密码')}" />
          <button class="button outline small" data-action="set-password" data-name="${escapeHtml(site.name)}" ${state.busy ? 'disabled' : ''}>${t('Set', '设置')}</button>
        </div>` : ''}
        <div class="actions">
          <button class="button outline small" data-action="open" data-name="${escapeHtml(site.name)}">${icons.open}${t('Open in browser', '在浏览器打开')}</button>
          <span class="spacer"></span>
          <button class="button destructive small" data-action="delete" data-name="${escapeHtml(site.name)}" ${state.busy ? 'disabled' : ''}>${armed ? t('Confirm delete', '确认删除') : t('Delete', '删除')}</button>
        </div>
      </div>` : ''}
    </article>`
  }

  root.addEventListener('click', async event => {
    const anchor = event.target.closest('a[href]')
    if (anchor) event.preventDefault()
    const button = event.target.closest('[data-action]')
    if (!button) return
    const action = button.dataset.action
    const name = button.dataset.name || ''
    if (action === 'refresh') return void refresh()
    if (action === 'toggle-publish') {
      state.publishOpen = !state.publishOpen
      if (state.publishOpen && !state.candidates) void loadCandidates()
      return void render()
    }
    if (action === 'toggle-site') { state.expanded = state.expanded === name ? '' : name; state.confirmDelete = ''; return void render() }
    if (action === 'copy-url') {
      const url = button.dataset.url || ''
      try {
        await navigator.clipboard.writeText(url)
        state.copiedUrl = url
        render()
        setTimeout(() => { if (state.copiedUrl === url) { state.copiedUrl = ''; render() } }, 1_400)
      } catch { state.error = t('Could not copy the link.', '无法复制链接。'); render() }
      return
    }
    if (action === 'dismiss-error') { state.error = ''; return void render() }
    if (action === 'setup') {
      const result = await act(t('Setting up publishing…', '正在开通发布…'), () => request('sites.setup', {}))
      return void refresh(true)
    }
    if (action === 'publish') return void publish()
    if (action === 'visibility') {
      const visibility = button.dataset.visibility || 'public'
      const password = visibility === 'password' ? (document.getElementById(`password-${name}`)?.value || '') : undefined
      const result = await act(t('Updating…', '正在更新…'), () => request('sites.setAccess', { name, visibility, password }))
      if (result?.password) state.revealedPassword = { name, password: result.password }
      else if (result) state.revealedPassword = null
      return void refresh(true)
    }
    if (action === 'set-password') {
      const password = document.getElementById(`password-${name}`)?.value || ''
      const result = await act(t('Updating…', '正在更新…'), () => request('sites.setAccess', { name, visibility: 'password', password }))
      if (result?.password) state.revealedPassword = { name, password: result.password }
      return void refresh(true)
    }
    if (action === 'delete') {
      if (state.confirmDelete !== name) { state.confirmDelete = name; return void render() }
      const result = await act(t('Taking the site down…', '正在下线站点…'), () => request('sites.delete', { name }))
      if (result) { state.confirmDelete = ''; state.expanded = '' }
      return void refresh(true)
    }
    // Opening needs no message: the browser is the feedback.
    if (action === 'open') await act('', () => request('sites.open', { name }))
  })

  render()
  refresh()
})()
