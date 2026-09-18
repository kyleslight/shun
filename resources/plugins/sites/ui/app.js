(() => {
  const channel = new URLSearchParams(location.search).get('channel') || ''
  const root = document.getElementById('app')
  const pending = new Map()
  let sequence = 0
  const state = {
    context: null, status: null, loading: true, busy: '', error: '', notice: '', noticeUrl: '',
    publishOpen: false, zones: null, loadingZones: false, expanded: '', confirmDelete: '', theme: '',
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

  function t(en, zh) { return state.context?.language === 'zh' ? zh : en }

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

  async function refresh(silent = false) {
    if (!silent) { state.loading = true; render() }
    try {
      state.status = await request('sites.status')
      state.error = ''
    } catch (error) { state.error = errorText(error) } finally { state.loading = false; render() }
  }

  async function loadZones() {
    state.loadingZones = true; state.error = ''; render()
    try { state.zones = (await request('sites.zones')).zones || [] }
    catch (error) { state.error = errorText(error) }
    finally { state.loadingZones = false; render() }
  }

  /** Every mutation runs through here so the panel shows one honest status line. */
  async function act(label, run) {
    state.busy = label; state.error = ''; state.notice = ''; state.noticeUrl = ''; state.noticeCopy = ''
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
    const slug = document.getElementById('publish-slug')?.value || ''
    const visibility = document.getElementById('publish-visibility')?.value || 'public'
    const result = await act(t('Publishing…', '正在发布…'), () => request('sites.publish', { path, slug, visibility }))
    if (!result) { await refresh(true); return }
    state.notice = result.message || t('Published.', '已发布。')
    state.noticeUrl = result.site?.url || ''
    state.publishOpen = false
    await refresh(true)
  }

  function render() {
    const status = state.status
    if (!status && state.loading) return void (root.innerHTML = shell(`<div class="state">${icons.cloud}<p>${t('Checking Cloudflare…', '正在检查 Cloudflare…')}</p></div>`))
    if (!status) return void (root.innerHTML = shell(banners() + `<div class="state">${icons.alert}<h2>${t('Sites is unavailable', 'Sites 不可用')}</h2><p>${escapeHtml(state.error || t('Try again in a moment.', '请稍后重试。'))}</p><div class="actions"><button class="ghost" data-action="refresh">${t('Try again', '重试')}</button></div></div>`))
    if (status.blocker) return void (root.innerHTML = shell(blocked(status), statusSum(status)))
    root.innerHTML = shell(ready(status), statusSum(status))
  }

  function statusSum(status) {
    const sites = status?.sites || []
    if (!status?.config) return t('Not set up', '尚未开通')
    return `${sites.length}${t(sites.length === 1 ? ' site' : ' sites', ' 个站点')} · ${escapeHtml(status.config.baseDomain)}`
  }

  function shell(body, summary) {
    return `<section class="sites">
      <header class="toolbar">
        <span class="summary">${summary || t('Sites', 'Sites')}</span>
        <button class="icon-button" data-action="refresh" aria-label="${t('Refresh', '刷新')}" title="${t('Refresh', '刷新')}">${icons.refresh}</button>
        ${state.status?.config && state.status.workspace ? `<button class="primary" data-action="toggle-publish" ${state.busy ? 'disabled' : ''}>${icons.upload}${t('Publish', '发布')}</button>` : ''}
      </header>
      <div class="body">${body}</div>
    </section>`
  }

  function banners() {
    const parts = []
    if (state.error) parts.push(`<div class="banner error">${escapeHtml(state.error)}</div>`)
    if (state.notice) {
      const copyable = state.noticeCopy || state.noticeUrl
      parts.push(`<div class="banner ok">${escapeHtml(state.notice)}${copyable ? ` <code>${escapeHtml(state.noticeCopy || '')}</code> <button class="ghost" data-action="copy-url" data-url="${escapeHtml(copyable)}">${icons.copy}${t('Copy', '复制')}</button>` : ''}</div>`)
    }
    if (state.busy) parts.push(`<div class="banner">${escapeHtml(state.busy)}</div>`)
    if (state.status?.warning) parts.push(`<div class="banner warn">${escapeHtml(state.status.warning)}</div>`)
    return parts.join('')
  }

  function blocked(status) {
    const connected = Boolean(status.connection?.connected)
    if (!connected) {
      return `<div class="state">${icons.cloud}
        <h2>${t('Connect Cloudflare first', '先连接 Cloudflare')}</h2>
        <p>${escapeHtml(status.blocker || '')}</p>
        <p class="field-note">${t('Sites publishes through the Cloudflare connection this app already uses.', 'Sites 通过本应用已有的 Cloudflare 连接发布。')}</p>
      </div>`
    }
    const zones = state.zones
    return `<div class="state">${icons.cloud}
      <h2>${t('Where should sites live?', '站点要放在哪个域名下？')}</h2>
      <p>${t('Pick the Cloudflare zone that will host your published sites. One wildcard address is set up once and reused by every site you publish later.', '选择托管已发布站点的 Cloudflare zone。通配地址只配置一次，之后每个站点都复用它。')}</p>
      ${zones === null
        ? `<div class="actions"><button class="ghost" data-action="load-zones" ${state.loadingZones ? 'disabled' : ''}>${state.loadingZones ? t('Reading zones…', '正在读取 zone…') : t('Choose a zone', '选择 zone')}</button></div>`
        : `<div class="setup">
            <label>${t('Zone', 'Zone')}<select id="setup-zone">${zones.map(zone => `<option value="${escapeHtml(zone.id)}">${escapeHtml(zone.name)}${zone.accountName ? ` · ${escapeHtml(zone.accountName)}` : ''}</option>`).join('')}</select></label>
            <label>${t('Sites domain (optional)', '站点域名（可选）')}<input id="setup-domain" placeholder="${escapeHtml(zones[0]?.name || 'example.com')}" spellcheck="false" /></label>
            <div class="actions"><button class="primary" data-action="setup" ${state.busy ? 'disabled' : ''}>${icons.check}${t('Set up publishing', '开通发布')}</button></div>
          </div>`}
    </div>`
  }

  function ready(status) {
    const sites = status.sites || []
    const candidates = status.candidates || []
    const paths = candidates.length ? candidates : (status.buildScript ? [`dist`, `build`] : [])
    const form = state.publishOpen ? `<div class="publish-form">
      <label>${t('Folder to publish', '要发布的目录')}
        ${paths.length
          ? `<select id="publish-path">${paths.map(path => `<option value="${escapeHtml(path)}">${escapeHtml(path)}</option>`).join('')}</select>`
          : `<input id="publish-path" placeholder="dist" spellcheck="false" />`}
      </label>
      <div class="row">
        <label>${t('Site name', '站点名')}<input id="publish-slug" placeholder="${escapeHtml(sites[0]?.slug || 'my-site')}" spellcheck="false" /></label>
        <label>${t('Visibility', '可见性')}<select id="publish-visibility">
          <option value="public">${t('Public', '公开')}</option>
          <option value="password">${t('Password', '密码保护')}</option>
          <option value="off">${t('Paused', '暂停')}</option>
        </select></label>
      </div>
      <div class="hint">${status.buildScript ? `${t('Build first if needed', '如需先构建')}: <code>${escapeHtml(status.buildScript)}</code>. ` : ''}${t('Only the files that changed are uploaded.', '只上传发生变化的文件。')}</div>
      <div class="form-actions"><button class="primary" data-action="publish" ${state.busy ? 'disabled' : ''}>${icons.upload}${t('Publish now', '立即发布')}</button><button class="ghost" data-action="toggle-publish">${t('Cancel', '取消')}</button></div>
    </div>` : ''
    const list = sites.length
      ? `<div class="list">${sites.map(siteRow).join('')}</div>`
      : `<div class="state">${icons.globe}<h2>${t('Nothing published yet', '还没有发布任何站点')}</h2><p>${t('Build the project, then publish its output folder. The site gets an address under', '先构建项目，然后发布输出目录。站点会得到一个地址：')} ${escapeHtml(status.config.baseDomain)}.</p></div>`
    return banners() + form + list
  }

  function siteRow(site) {
    const open = state.expanded === site.slug
    const armed = state.confirmDelete === site.slug
    return `<article class="site${open ? ' open' : ''}" data-slug="${escapeHtml(site.slug)}">
      <div class="site-head">
        <div class="site-name"><b>${escapeHtml(site.title || site.slug)}</b><span>${escapeHtml(site.host)}</span></div>
        <span class="chip ${site.visibility === 'public' ? 'on' : site.visibility === 'password' ? 'warn' : 'off'}">${visibilityLabel(site.visibility)}</span>
        <button class="icon-button" data-action="toggle-site" data-slug="${escapeHtml(site.slug)}" aria-label="${t('Manage', '管理')}" title="${t('Manage', '管理')}">${icons.chevron}</button>
      </div>
      <div class="site-meta"><span>${site.files} ${t('files', '个文件')}</span><span>·</span><span>${formatBytes(site.bytes)}</span><span>·</span><span>${relativeTime(site.publishedAt)}</span></div>
      ${open ? `<div class="site-actions">
        <div class="segmented">
          <button data-action="visibility" data-slug="${escapeHtml(site.slug)}" data-visibility="public" class="${site.visibility === 'public' ? 'active' : ''}" ${state.busy ? 'disabled' : ''}>${t('Public', '公开')}</button>
          <button data-action="visibility" data-slug="${escapeHtml(site.slug)}" data-visibility="password" class="${site.visibility === 'password' ? 'active' : ''}" ${state.busy ? 'disabled' : ''}>${t('Password', '密码')}</button>
          <button data-action="visibility" data-slug="${escapeHtml(site.slug)}" data-visibility="off" class="${site.visibility === 'off' ? 'active' : ''}" ${state.busy ? 'disabled' : ''}>${t('Paused', '暂停')}</button>
        </div>
        ${site.visibility === 'password' ? `<div class="password-row">
          <input id="password-${escapeHtml(site.slug)}" type="password" autocomplete="new-password" placeholder="${t('New password', '新密码')}" />
          <button class="ghost" data-action="set-password" data-slug="${escapeHtml(site.slug)}" ${state.busy ? 'disabled' : ''}>${t('Set', '设置')}</button>
          <span class="field-note">${t('Stored as a hash.', '以哈希存储。')}</span>
        </div>` : ''}
        <div class="actions-row">
          <button class="ghost" data-action="open" data-slug="${escapeHtml(site.slug)}">${icons.open}${t('Open', '打开')}</button>
          <button class="ghost" data-action="copy-url" data-url="${escapeHtml(site.url)}">${icons.copy}${t('Copy link', '复制链接')}</button>
          <span class="spacer"></span>
          <button class="danger-button" data-action="delete" data-slug="${escapeHtml(site.slug)}" ${state.busy ? 'disabled' : ''}>${armed ? t('Confirm delete', '确认删除') : t('Delete', '删除')}</button>
        </div>
      </div>` : ''}
    </article>`
  }

  root.addEventListener('click', async event => {
    const button = event.target.closest('[data-action]')
    if (!button) return
    const action = button.dataset.action
    const slug = button.dataset.slug || ''
    if (action === 'refresh') return void refresh()
    if (action === 'toggle-publish') { state.publishOpen = !state.publishOpen; return void render() }
    if (action === 'load-zones') return void loadZones()
    if (action === 'toggle-site') { state.expanded = state.expanded === slug ? '' : slug; state.confirmDelete = ''; return void render() }
    if (action === 'copy-url') {
      const url = button.dataset.url || ''
      try { await navigator.clipboard.writeText(url); state.notice = t('Link copied.', '链接已复制。'); state.noticeUrl = '' } catch { state.error = t('Could not copy the link.', '无法复制链接。') }
      return void render()
    }
    if (action === 'setup') {
      const zoneId = document.getElementById('setup-zone')?.value || ''
      const baseDomain = document.getElementById('setup-domain')?.value || ''
      const result = await act(t('Setting up publishing…', '正在开通发布…'), () => request('sites.setup', { zone_id: zoneId, base_domain: baseDomain }))
      if (result) state.notice = result.message || ''
      return void refresh(true)
    }
    if (action === 'publish') return void publish()
    if (action === 'visibility') {
      const visibility = button.dataset.visibility || 'public'
      const password = visibility === 'password' ? (document.getElementById(`password-${slug}`)?.value || '') : undefined
      const result = await act(t('Updating…', '正在更新…'), () => request('sites.setAccess', { slug, visibility, password }))
      if (result?.password) { state.notice = t('Password for this site (shown once):', '该站点密码（仅显示一次）：'); state.noticeCopy = result.password }
      else if (result) state.notice = result.visibility === 'public' ? t('The site is public again.', '站点已恢复公开。') : result.visibility === 'password' ? t('The site now asks for a password.', '站点现在需要密码。') : t('The site is paused.', '站点已暂停。')
      return void refresh(true)
    }
    if (action === 'set-password') {
      const password = document.getElementById(`password-${slug}`)?.value || ''
      const result = await act(t('Updating…', '正在更新…'), () => request('sites.setAccess', { slug, visibility: 'password', password }))
      if (result?.password) { state.notice = t('Password for this site (shown once):', '该站点密码（仅显示一次）：'); state.noticeCopy = result.password }
      else if (result) state.notice = t('The site now asks for a password.', '站点现在需要密码。')
      return void refresh(true)
    }
    if (action === 'delete') {
      if (state.confirmDelete !== slug) { state.confirmDelete = slug; return void render() }
      const result = await act(t('Taking the site down…', '正在下线站点…'), () => request('sites.delete', { slug }))
      if (result) { state.notice = t('The site is offline and its files are gone.', '站点已下线，文件已删除。'); state.confirmDelete = ''; state.expanded = '' }
      return void refresh(true)
    }
    if (action === 'open') {
      await act(t('Opening…', '正在打开…'), () => request('sites.open', { slug }))
    }
  })

  render()
  refresh()
})()


/* probe 1789726348953 */



