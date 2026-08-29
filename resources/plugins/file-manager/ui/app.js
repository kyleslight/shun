(() => {
  const params = new URLSearchParams(location.search)
  const channel = params.get('channel') || ''
  const root = document.getElementById('app')
  const pending = new Map()
  const ROW_HEIGHT = 28
  const TEXT_LIMIT = 768 * 1024
  const MEDIA_LIMIT = 64 * 1024 * 1024
  let sequence = 0, searchTimer = 0, refreshTimer = 0, copyPathTimer = 0, previewUrl = '', refreshOverflow = false, workspaceReset = Promise.resolve(), fileSelectionQueue = Promise.resolve()
  const refreshPaths = new Set()
  const state = {
    context: null, directories: new Map(), expanded: new Set(), loadingDirectories: new Set(),
    selected: null, preview: null, previewRequest: 0, query: '', results: null, searching: false,
    searchTruncated: false, error: '', treeScroll: 0, treeCollapsed: false, copyPathStatus: '',
  }

  const icons = {
    folder: '<svg viewBox="0 0 24 24"><path d="M3.5 7.5h6l1.8 2h9.2v8a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2v-10Z"/><path d="M3.5 7.5v-1a2 2 0 0 1 2-2h4l1.8 2h7.2a2 2 0 0 1 2 2v1"/></svg>',
    file: '<svg viewBox="0 0 24 24"><path d="M6 3.5h7l5 5v12H6z"/><path d="M13 3.5v5h5"/></svg>',
    chevron: '<svg viewBox="0 0 24 24"><path d="m9 6 6 6-6 6"/></svg>',
    search: '<svg viewBox="0 0 24 24"><circle cx="10.8" cy="10.8" r="6.3"/><path d="m16 16 4.2 4.2"/></svg>',
    refresh: '<svg viewBox="0 0 24 24"><path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 5v6h-6"/></svg>',
    panel: '<svg viewBox="0 0 24 24"><rect x="3.5" y="4" width="17" height="16" rx="2"/><path d="M9 4v16M15 9l-3 3 3 3"/></svg>',
    external: '<svg viewBox="0 0 24 24"><path d="M14 4h6v6M20 4l-9 9"/><path d="M18 13v6H5V6h6"/></svg>',
    copy: '<svg viewBox="0 0 24 24"><rect x="8" y="8" width="11" height="11" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/></svg>',
    check: '<svg viewBox="0 0 24 24"><path d="m5 12 4 4L19 6"/></svg>',
    eye: '<svg viewBox="0 0 24 24"><path d="M3 12s3.4-6 9-6 9 6 9 6-3.4 6-9 6-9-6-9-6Z"/><circle cx="12" cy="12" r="2.5"/></svg>',
    x: '<svg viewBox="0 0 24 24"><path d="m7 7 10 10M17 7 7 17"/></svg>',
  }

  function zh() { return state.context?.language === 'zh' }
  function t(en, cn) { return zh() ? cn : en }
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
    if (message.type === 'event' && message.event === 'workspace.changed') {
      scheduleRefresh(message.payload)
      return
    }
    if (message.type === 'event' && message.event === 'file.open') {
      const requestId = String(message.payload?.requestId || '')
      if (!requestId || requestId === state.fileRequestId) return
      state.fileRequestId = requestId
      fileSelectionQueue = fileSelectionQueue.catch(() => {}).then(() => workspaceReset).then(() => openRequestedFile(message.payload))
      return
    }
    if (message.type === 'context') {
      const changed = state.context?.workspace !== message.context?.workspace
      state.context = message.context
      applyTheme(message.context)
      updateLabels()
      if (changed) workspaceReset = resetWorkspace()
    }
  })

  function applyTheme(context) {
    const light = context?.theme === 'light' || (context?.theme === 'system' && matchMedia('(prefers-color-scheme: light)').matches)
    document.documentElement.dataset.theme = light ? 'light' : 'dark'
    document.documentElement.style.colorScheme = light ? 'light' : 'dark'
    const map = { accent: 'accent', 'app-bg': 'bg', 'sidebar-bg': 'sidebar-source', 'surface-1': 'panel', 'surface-2': 'raised', 'surface-3': 'surface', 'border-1': 'line', 'border-2': 'line-strong', 'text-1': 'text', 'text-2': 'text-secondary', 'text-3': 'muted', 'text-4': 'faint', 'code-bg': 'code-bg' }
    for (const [source, target] of Object.entries(map)) {
      const value = context?.themeTokens?.[source]
      if (value) document.documentElement.style.setProperty(`--${target}`, value)
    }
  }

  function renderShell() {
    root.innerHTML = `<section class="browser">
      <header class="toolbar">
        <div class="location" id="location"></div>
        <label class="search">${icons.search}<input id="search" type="search" autocomplete="off" spellcheck="false"><button class="clear-search" data-action="clear-search" aria-label="Clear">${icons.x}</button></label>
        <button class="icon-button" data-action="refresh" id="refresh" aria-label="Refresh">${icons.refresh}</button>
      </header>
      <div class="workspace${state.treeCollapsed ? ' tree-collapsed' : ''}">
        <aside class="tree-pane">
          <div class="tree-head"><b id="workspace-name"></b><span id="tree-status"></span><button class="tree-toggle" data-action="toggle-tree">${icons.panel}</button></div>
          <div class="tree" id="tree" role="tree" tabindex="0"><div class="tree-state"></div></div>
        </aside>
        <section class="preview" id="preview"></section>
      </div>
    </section>`
    root.addEventListener('click', onClick)
    root.addEventListener('dblclick', onDoubleClick)
    root.addEventListener('input', onInput)
    root.addEventListener('keydown', onKeyDown)
    root.querySelector('#tree').addEventListener('scroll', event => { state.treeScroll = event.currentTarget.scrollTop; renderTree() }, { passive: true })
    updateLabels()
    renderTree()
    renderPreview()
  }

  function updateLabels() {
    const search = root.querySelector('#search'), refresh = root.querySelector('#refresh')
    if (search) search.placeholder = t('Search files', '搜索文件')
    if (refresh) refresh.setAttribute('aria-label', t('Refresh', '刷新'))
    const workspaceName = root.querySelector('#workspace-name')
    if (workspaceName) workspaceName.textContent = workspaceLabel()
    renderLocation()
    renderTreeStatus()
    updateTreeToggle()
  }

  function workspaceLabel() {
    const path = state.context?.workspace || ''
    return path.split(/[\\/]/).filter(Boolean).pop() || t('Workspace', '工作区')
  }

  async function resetWorkspace() {
    revokePreviewUrl()
    clearTimeout(copyPathTimer); state.copyPathStatus = ''
    state.directories.clear(); state.expanded.clear(); state.loadingDirectories.clear(); state.selected = null
    state.preview = null; state.previewRequest++; state.query = ''; state.results = null; state.searching = false; state.error = ''; state.treeScroll = 0
    const input = root.querySelector('#search'); if (input) input.value = ''
    renderTree(); renderPreview(); updateLabels()
    if (state.context?.workspace) await loadDirectory('.')
  }

  async function loadDirectory(path, force = false) {
    if (!state.context?.workspace || state.loadingDirectories.has(path) || (!force && state.directories.has(path))) return
    const workspace = state.context.workspace
    state.loadingDirectories.add(path); state.error = ''; renderTree(); renderTreeStatus()
    try {
      const result = await request('workspace.list', { path, recursive: false, limit: 2000 })
      if (workspace !== state.context?.workspace) return
      const entries = [...(result.entries || [])].sort((a, b) => a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'directory' ? -1 : 1)
      state.directories.set(path, { entries, truncated: Boolean(result.truncated) })
    } catch (error) { if (workspace === state.context?.workspace) state.error = error.message || String(error) }
    finally { state.loadingDirectories.delete(path); renderTree(); renderTreeStatus() }
  }

  async function toggleDirectory(path) {
    if (state.expanded.has(path)) { state.expanded.delete(path); renderTree(); return }
    state.expanded.add(path); renderTree()
    await loadDirectory(path)
  }

  async function openRequestedFile(payload) {
    const requestId = String(payload?.requestId || ''), path = String(payload?.path || '').replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/$/, '')
    if (!requestId || requestId !== state.fileRequestId || !path || path.startsWith('/') || path.split('/').some(part => !part || part === '.' || part === '..')) return
    const fail = () => {
      const entry = { path, name: path.split('/').pop() || path, kind: 'file', size: 0 }
      state.selected = entry; state.preview = { mode: 'error', entry, detail: t('File is no longer available in this workspace.', '文件已不在当前工作区中。') }
      renderTree(); renderLocation(); renderPreview()
    }
    if (payload?.collapseTree) state.treeCollapsed = true
    clearTimeout(searchTimer); state.query = ''; state.results = null; state.searching = false; state.error = ''; state.treeScroll = 0
    const input = root.querySelector('#search'), tree = root.querySelector('#tree')
    if (input) input.value = ''
    if (tree) tree.scrollTop = 0
    updateTreeToggle()
    await loadDirectory('.')
    let directory = '.'
    const parts = path.split('/')
    for (let index = 0; index < parts.length - 1; index++) {
      if (requestId !== state.fileRequestId) return
      const next = directory === '.' ? parts[index] : `${directory}/${parts[index]}`
      const entry = state.directories.get(directory)?.entries.find(item => item.path === next && item.kind === 'directory')
      if (!entry) { fail(); return }
      state.expanded.add(next)
      await loadDirectory(next)
      directory = next
    }
    if (requestId !== state.fileRequestId) return
    const entry = state.directories.get(directory)?.entries.find(item => item.path === path && item.kind === 'file')
    if (!entry) { fail(); return }
    await selectFile(entry)
  }

  function visibleRows() {
    if (state.results) return state.results.map(entry => ({ entry, depth: 0, search: true }))
    const rows = []
    const append = (directory, depth) => {
      for (const entry of state.directories.get(directory)?.entries || []) {
        rows.push({ entry, depth, search: false })
        if (entry.kind === 'directory' && state.expanded.has(entry.path)) append(entry.path, depth + 1)
      }
    }
    append('.', 0)
    return rows
  }

  function renderTree() {
    const tree = root.querySelector('#tree')
    if (!tree) return
    const layout = document.getElementById('runtime-layout')
    if (!state.context?.workspace) { layout.textContent = ''; tree.innerHTML = `<div class="tree-state">${escapeHtml(t('Choose a workspace to browse files.', '选择工作区后即可浏览文件。'))}</div>`; return }
    if (!state.directories.has('.') && state.loadingDirectories.has('.')) { layout.textContent = ''; tree.innerHTML = '<div class="tree-state"><span class="spinner"></span></div>'; return }
    const rows = visibleRows()
    if (!rows.length) {
      const label = state.searching ? t('Searching…', '正在搜索…') : state.query ? t('No matching files', '没有匹配的文件') : state.error || t('This folder is empty', '此文件夹为空')
      layout.textContent = ''
      tree.innerHTML = `<div class="tree-state${state.error ? ' error' : ''}">${escapeHtml(label)}</div>`
      return
    }
    const height = tree.clientHeight || 400, start = Math.max(0, Math.floor(state.treeScroll / ROW_HEIGHT) - 8), end = Math.min(rows.length, Math.ceil((state.treeScroll + height) / ROW_HEIGHT) + 8)
    let html = '<div class="tree-space">', rules = `.tree-space{height:${rows.length * ROW_HEIGHT}px}`
    for (let index = start; index < end; index++) {
      const { entry, depth, search } = rows[index], directory = entry.kind === 'directory', expanded = state.expanded.has(entry.path), selected = state.selected?.path === entry.path
      const label = search ? entry.path : entry.name
      rules += `.tree-row[data-index="${index}"]{transform:translateY(${index * ROW_HEIGHT}px);padding-left:${8 + Math.min(depth, 20) * 14}px}`
      html += `<button class="tree-row${selected ? ' active' : ''}" data-index="${index}" data-path="${escapeAttr(entry.path)}" data-kind="${entry.kind}" role="treeitem" aria-selected="${selected}"${directory ? ` aria-expanded="${expanded}"` : ''}>
        <span class="chevron${directory ? '' : ' hidden'}${expanded ? ' open' : ''}">${icons.chevron}</span><span class="file-icon ${directory ? 'folder' : fileIconClass(entry.name)}">${directory ? icons.folder : icons.file}</span><span class="tree-label">${escapeHtml(label)}</span>${state.loadingDirectories.has(entry.path) ? '<span class="row-spinner spinner"></span>' : ''}
      </button>`
    }
    layout.textContent = rules
    tree.innerHTML = `${html}</div>`
  }

  function renderTreeStatus() {
    const target = root.querySelector('#tree-status')
    if (!target) return
    if (state.searching) target.textContent = t('Searching…', '搜索中…')
    else if (state.results) target.textContent = `${state.results.length}${state.searchTruncated ? '+' : ''}`
    else target.textContent = state.directories.get('.')?.truncated ? t('2,000+ items', '2,000+ 项') : ''
  }

  function updateTreeToggle() {
    const workspace = root.querySelector('.workspace'), button = root.querySelector('[data-action="toggle-tree"]')
    workspace?.classList.toggle('tree-collapsed', state.treeCollapsed)
    if (!button) return
    const label = state.treeCollapsed ? t('Expand file tree', '展开文件树') : t('Collapse file tree', '收起文件树')
    button.classList.toggle('collapsed', state.treeCollapsed); button.setAttribute('aria-label', label); button.title = label
  }

  async function selectFile(entry) {
    clearTimeout(copyPathTimer); state.copyPathStatus = ''; state.selected = entry; state.preview = { mode: 'loading' }; state.error = ''; renderTree(); renderLocation(); renderPreview()
    const version = ++state.previewRequest, kind = classify(entry.name)
    try {
      if (kind.mode === 'office') state.preview = { ...kind, entry }
      else if (kind.mode === 'text' || kind.mode === 'unsupported') {
        const length = Math.min(Number(entry.size || 0), TEXT_LIMIT) || TEXT_LIMIT
        const bytes = await readChunk(entry.path, 0, length)
        if (version !== state.previewRequest) return
        if (looksBinary(bytes)) state.preview = { mode: 'unsupported', entry, detail: t('Binary file', '二进制文件') }
        else state.preview = { mode: 'text', entry, text: decodeText(bytes), code: kind.mode === 'text' && kind.code, language: kind.mode === 'text' ? kind.language : t('Plain text', '纯文本'), truncated: Number(entry.size || 0) > bytes.length }
      } else if (kind.mode === 'pdf') {
        if (Number(entry.size || 0) > MEDIA_LIMIT) state.preview = { mode: 'unsupported', entry, detail: t('PDF is too large for an inline preview', 'PDF 过大，无法内嵌预览') }
        else {
          const page = await request('workspace.pdfPage', { path: entry.path, page: 1, maxDimension: pdfRenderDimension() })
          if (version !== state.previewRequest) return
          state.preview = { ...kind, entry, ...page, loading: false }
        }
      } else {
        if (Number(entry.size || 0) > MEDIA_LIMIT) state.preview = { mode: 'unsupported', entry, detail: t('File is too large for an inline preview', '文件过大，无法内嵌预览') }
        else {
          const bytes = await readWhole(entry)
          if (version !== state.previewRequest) return
          revokePreviewUrl(); previewUrl = URL.createObjectURL(new Blob([bytes], { type: kind.mime }))
          state.preview = { ...kind, entry, url: previewUrl }
        }
      }
    } catch (error) { if (version === state.previewRequest) state.preview = { mode: 'error', entry, detail: error.message || String(error) } }
    if (version === state.previewRequest) renderPreview()
  }

  async function readChunk(path, offset, length) {
    const result = await request('workspace.read', { path, offset, length })
    return base64Bytes(result.data)
  }

  async function readWhole(entry) {
    const expected = Number(entry.size || 0), chunks = []
    let offset = 0, total = 0
    while (offset < expected || !expected) {
      const result = await request('workspace.read', { path: entry.path, offset, length: 1024 * 1024 })
      const bytes = base64Bytes(result.data); chunks.push(bytes); total += bytes.length
      if (result.nextOffset === undefined) break
      offset = result.nextOffset
      if (total > MEDIA_LIMIT) throw Error(t('File is too large for an inline preview.', '文件过大，无法内嵌预览。'))
    }
    const joined = new Uint8Array(total); let cursor = 0
    for (const chunk of chunks) { joined.set(chunk, cursor); cursor += chunk.length }
    return joined
  }

  function base64Bytes(value) {
    const binary = atob(value || ''), bytes = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index)
    return bytes
  }

  function decodeText(bytes) {
    if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes.subarray(2))
    if (bytes[0] === 0xfe && bytes[1] === 0xff) {
      const swapped = bytes.subarray(2).slice()
      for (let index = 0; index + 1 < swapped.length; index += 2) [swapped[index], swapped[index + 1]] = [swapped[index + 1], swapped[index]]
      return new TextDecoder('utf-16le').decode(swapped)
    }
    return new TextDecoder('utf-8').decode(bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? bytes.subarray(3) : bytes)
  }

  function looksBinary(bytes) {
    if ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff)) return false
    const sample = bytes.subarray(0, Math.min(bytes.length, 8192))
    let controls = 0
    for (const byte of sample) { if (byte === 0) return true; if (byte < 7 || (byte > 13 && byte < 32)) controls++ }
    return sample.length > 0 && controls / sample.length > .08
  }

  function renderLocation() {
    const target = root.querySelector('#location')
    if (!target) return
    const selected = state.selected?.path
    const copied = state.copyPathStatus === 'copied', failed = state.copyPathStatus === 'error'
    const copyLabel = failed ? t('Could not copy path', '无法复制路径') : copied ? t('Path copied', '路径已复制') : t('Copy file path', '复制文件路径')
    target.innerHTML = `<b>${escapeHtml(workspaceLabel())}</b>${selected ? `<span>/</span><span title="${escapeAttr(selected)}">${escapeHtml(selected)}</span><button class="copy-path${copied ? ' copied' : ''}${failed ? ' failed' : ''}" data-action="copy-path" aria-label="${escapeAttr(copyLabel)}" title="${escapeAttr(copyLabel)}">${copied ? icons.check : failed ? icons.x : icons.copy}</button>` : ''}`
  }

  function renderPreview() {
    const target = root.querySelector('#preview')
    if (!target) return
    const preview = state.preview
    if (!state.selected) { target.innerHTML = `<div class="empty-preview">${icons.eye}<b>${escapeHtml(t('Select a file to preview', '选择文件以预览'))}</b><p>${escapeHtml(t('Code, images, audio, and PDFs open here.', '代码、图片、音频和 PDF 会直接在这里打开。'))}</p></div>`; return }
    if (!preview || preview.mode === 'loading') { target.innerHTML = '<div class="empty-preview"><span class="spinner"></span></div>'; return }
    if (preview.mode === 'text') {
      const body = preview.code ? highlightCode(preview.text, preview.language) : escapeHtml(preview.text)
      target.innerHTML = `<div class="text-preview">${previewFooter(preview, preview.truncated ? t('Partial preview', '部分预览') : preview.language)}<pre class="${preview.code ? 'code' : 'plain'}"><code>${body}</code></pre></div>`
      return
    }
    if (preview.mode === 'image') {
      target.innerHTML = `<div class="media-preview">${previewFooter(preview, preview.mime)}<div class="image-stage"><img src="${preview.url}" alt=""></div></div>`
      const image = target.querySelector('.image-stage img')
      image.addEventListener('load', () => {
        if (state.preview !== preview) return
        preview.width = image.naturalWidth; preview.height = image.naturalHeight
        const detail = target.querySelector('.preview-footer small')
        if (detail) detail.textContent = previewMeta(preview, preview.mime)
      }, { once: true })
      return
    }
    if (preview.mode === 'audio') { target.innerHTML = `<div class="media-preview">${previewFooter(preview, preview.mime)}<div class="audio-stage"><div class="audio-art">♫</div><b>${escapeHtml(preview.entry.name)}</b><audio controls preload="metadata" src="${preview.url}"></audio></div></div>`; return }
    if (preview.mode === 'pdf') {
      const source = `data:${preview.mimeType};base64,${preview.data}`
      target.innerHTML = `<div class="media-preview">${previewFooter(preview, `PDF · ${preview.page}/${preview.pages}`)}<div class="pdf-stage"><img class="pdf-page" src="${source}" alt="${escapeAttr(t(`Page ${preview.page}`, `第 ${preview.page} 页`))}"><nav class="pdf-pager" aria-label="${escapeAttr(t('PDF pages', 'PDF 页面'))}"><button data-action="pdf-prev"${preview.page <= 1 || preview.loading ? ' disabled' : ''}>${icons.chevron}</button><span>${preview.page} / ${preview.pages}</span><button data-action="pdf-next"${preview.page >= preview.pages || preview.loading ? ' disabled' : ''}>${icons.chevron}</button></nav>${preview.loading ? '<span class="pdf-spinner spinner"></span>' : ''}</div></div>`
      return
    }
    const office = preview.mode === 'office'
    target.innerHTML = `${previewFooter(preview, preview.mode === 'error' ? t('Preview failed', '预览失败') : fileType(preview.entry.name))}<div class="unsupported-preview"><span class="document-glyph">${office ? officeGlyph(preview.application) : icons.file}</span><b>${escapeHtml(preview.entry.name)}</b><p>${escapeHtml(preview.detail || (office ? t('Open with the desktop application for accurate rendering.', '使用桌面应用打开可获得准确渲染。') : t('Inline preview is not available for this file.', '此文件暂不支持内嵌预览。')))}</p><div class="preview-actions">${office ? `<button data-action="open-ms" data-application="${preview.application}">${icons.external}${escapeHtml(microsoftLabel(preview.application))}</button>` : ''}<button data-action="open-with">${icons.external}${escapeHtml(t('Open with…', '选择打开方式…'))}</button><button data-action="reveal">${icons.folder}${escapeHtml(t('Show in folder', '在文件夹中显示'))}</button></div></div>`
  }

  function previewFooter(preview, detail) {
    return `<footer class="preview-footer"><span><b title="${escapeAttr(preview.entry.path)}">${escapeHtml(preview.entry.name)}</b><small>${escapeHtml(previewMeta(preview, detail))}</small></span><div><button data-action="open-with" title="${escapeAttr(t('Choose application…', '选择打开方式…'))}">${icons.external}</button><button data-action="reveal" title="${escapeAttr(t('Show in folder', '在文件夹中显示'))}">${icons.folder}</button></div></footer>`
  }

  function previewMeta(preview, detail) {
    return [formatBytes(preview.entry.size), preview.width && preview.height && preview.mode === 'image' ? `${preview.width} × ${preview.height}` : '', detail].filter(Boolean).join(' · ')
  }

  function onClick(event) {
    const action = event.target.closest('[data-action]')?.dataset.action
    if (action === 'refresh') { void refreshWorkspace(); return }
    if (action === 'copy-path') { void copySelectedPath(); return }
    if (action === 'toggle-tree') { state.treeCollapsed = !state.treeCollapsed; updateTreeToggle(); if (!state.treeCollapsed) renderTree(); return }
    if (action === 'clear-search') { const input = root.querySelector('#search'), tree = root.querySelector('#tree'); input.value = ''; state.query = ''; state.results = null; state.searching = false; state.treeScroll = 0; tree.scrollTop = 0; renderTree(); renderTreeStatus(); input.focus(); return }
    if (action === 'open-default') { void openSelected('default'); return }
    if (action === 'open-with') { void openSelected('choose'); return }
    if (action === 'open-ms') { void openSelected(event.target.closest('[data-application]').dataset.application); return }
    if (action === 'reveal') { void revealSelected(); return }
    if (action === 'pdf-prev') { void loadPdfPage((state.preview?.page || 1) - 1); return }
    if (action === 'pdf-next') { void loadPdfPage((state.preview?.page || 1) + 1); return }
    const row = event.target.closest('.tree-row')
    if (!row) return
    const entry = findEntry(row.dataset.path, row.dataset.kind)
    if (!entry) return
    if (entry.kind === 'directory') void toggleDirectory(entry.path)
    else void selectFile(entry)
  }

  function onDoubleClick(event) {
    const row = event.target.closest('.tree-row')
    if (row?.dataset.kind === 'file') { state.selected = findEntry(row.dataset.path, 'file'); void openSelected('default') }
  }

  function onInput(event) {
    if (event.target.id !== 'search') return
    state.query = event.target.value.trim(); clearTimeout(searchTimer); state.treeScroll = 0; root.querySelector('#tree').scrollTop = 0
    if (!state.query) { state.results = null; state.searching = false; renderTree(); renderTreeStatus(); return }
    state.searching = true; state.results = []; renderTree(); renderTreeStatus()
    searchTimer = setTimeout(() => void searchFiles(), 180)
  }

  function onKeyDown(event) {
    if (event.key === 'Escape' && state.query) { event.preventDefault(); root.querySelector('[data-action="clear-search"]').click(); return }
    const row = event.target.closest('.tree-row')
    if (!row) return
    if (event.key === 'Enter') { event.preventDefault(); row.click(); return }
    if (event.key === 'ArrowRight' && row.dataset.kind === 'directory' && !state.expanded.has(row.dataset.path)) { event.preventDefault(); void toggleDirectory(row.dataset.path) }
    if (event.key === 'ArrowLeft' && row.dataset.kind === 'directory' && state.expanded.has(row.dataset.path)) { event.preventDefault(); state.expanded.delete(row.dataset.path); renderTree() }
  }

  async function searchFiles() {
    const query = state.query
    try {
      const result = await request('workspace.search', { query, limit: 300 })
      if (query !== state.query) return
      state.results = result.entries || []; state.searchTruncated = Boolean(result.truncated)
    } catch (error) { if (query === state.query) { state.results = []; state.error = error.message || String(error) } }
    finally { if (query === state.query) { state.searching = false; renderTree(); renderTreeStatus() } }
  }

  async function loadPdfPage(page) {
    const current = state.preview
    if (!state.selected || current?.mode !== 'pdf' || current.loading || page < 1 || page > current.pages) return
    const version = ++state.previewRequest, path = state.selected.path
    current.loading = true; renderPreview()
    try {
      const result = await request('workspace.pdfPage', { path, page, maxDimension: pdfRenderDimension() })
      if (version !== state.previewRequest || state.selected?.path !== path) return
      state.preview = { ...current, ...result, loading: false }
    } catch (error) {
      if (version === state.previewRequest) state.preview = { mode: 'error', entry: state.selected, detail: error.message || String(error) }
    }
    if (version === state.previewRequest) renderPreview()
  }

  async function refreshWorkspace(changes) {
    const expanded = [...state.expanded].sort((a, b) => a.split('/').length - b.split('/').length)
    state.directories.clear(); await loadDirectory('.')
    for (const path of expanded) await loadDirectory(path)
    if (state.query) void searchFiles()
    if (state.selected && (!changes || changes.overflow || (changes.paths || []).some(path => path === state.selected.path))) void selectFile(state.selected)
  }

  function scheduleRefresh(changes) {
    if (changes?.overflow) refreshOverflow = true
    for (const path of changes?.paths || []) refreshPaths.add(path)
    clearTimeout(refreshTimer)
    refreshTimer = setTimeout(() => {
      const batch = { overflow: refreshOverflow, paths: [...refreshPaths] }
      refreshOverflow = false; refreshPaths.clear()
      void refreshWorkspace(batch)
    }, 500)
  }
  async function openSelected(application) { if (!state.selected) return; try { await request('workspace.open', { path: state.selected.path, application }) } catch (error) { showError(error) } }
  async function revealSelected() { if (!state.selected) return; try { await request('workspace.reveal', { path: state.selected.path }) } catch (error) { showError(error) } }
  async function copySelectedPath() {
    if (!state.selected) return
    const path = state.selected.path
    try { await request('workspace.copyPath', { path }); if (state.selected?.path !== path) return; state.copyPathStatus = 'copied' }
    catch { if (state.selected?.path !== path) return; state.copyPathStatus = 'error' }
    renderLocation(); clearTimeout(copyPathTimer); copyPathTimer = setTimeout(() => { if (state.selected?.path === path) { state.copyPathStatus = ''; renderLocation() } }, 1400)
  }
  function showError(error) { state.preview = { mode: 'error', entry: state.selected, detail: error.message || String(error) }; renderPreview() }

  function findEntry(path, kind) {
    if (state.results) return state.results.find(entry => entry.path === path && entry.kind === kind)
    for (const directory of state.directories.values()) { const entry = directory.entries.find(item => item.path === path && item.kind === kind); if (entry) return entry }
    return null
  }

  function classify(name) {
    const ext = extension(name), image = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', svg: 'image/svg+xml', bmp: 'image/bmp', ico: 'image/x-icon' }
    const audio = { mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', oga: 'audio/ogg', m4a: 'audio/mp4', aac: 'audio/aac', flac: 'audio/flac', opus: 'audio/ogg' }
    const office = { doc: 'word', docx: 'word', docm: 'word', dotx: 'word', xls: 'excel', xlsx: 'excel', xlsm: 'excel', ppt: 'powerpoint', pptx: 'powerpoint', pptm: 'powerpoint' }
    if (image[ext]) return { mode: 'image', mime: image[ext] }
    if (audio[ext]) return { mode: 'audio', mime: audio[ext] }
    if (ext === 'pdf') return { mode: 'pdf', mime: 'application/pdf' }
    if (office[ext]) return { mode: 'office', application: office[ext] }
    const language = codeLanguage(ext, name)
    if (language) return { mode: 'text', code: true, language }
    if (name.startsWith('.')) return { mode: 'text', code: false, language: 'text' }
    if (['txt', 'log', 'md', 'markdown', 'rst', 'tex', 'csv', 'tsv', 'ini', 'cfg', 'conf', 'env'].includes(ext) || ['license', 'readme', 'changelog'].includes(name.toLowerCase())) return { mode: 'text', code: false, language: ext || 'text' }
    return { mode: 'unsupported' }
  }

  function codeLanguage(ext, name) {
    const map = { js: 'JavaScript', jsx: 'JSX', mjs: 'JavaScript', cjs: 'JavaScript', ts: 'TypeScript', tsx: 'TSX', json: 'JSON', jsonc: 'JSON', py: 'Python', rb: 'Ruby', rs: 'Rust', go: 'Go', java: 'Java', kt: 'Kotlin', kts: 'Kotlin', swift: 'Swift', c: 'C', h: 'C', cc: 'C++', cpp: 'C++', cxx: 'C++', hpp: 'C++', cs: 'C#', php: 'PHP', lua: 'Lua', dart: 'Dart', scala: 'Scala', sh: 'Shell', bash: 'Shell', zsh: 'Shell', fish: 'Shell', ps1: 'PowerShell', html: 'HTML', htm: 'HTML', xml: 'XML', css: 'CSS', scss: 'SCSS', less: 'Less', sql: 'SQL', graphql: 'GraphQL', gql: 'GraphQL', yml: 'YAML', yaml: 'YAML', toml: 'TOML', vue: 'Vue', svelte: 'Svelte', r: 'R', jl: 'Julia', ex: 'Elixir', exs: 'Elixir', erl: 'Erlang', fs: 'F#', fsx: 'F#', clj: 'Clojure', groovy: 'Groovy', proto: 'Protocol Buffers', sol: 'Solidity', tf: 'Terraform', dockerfile: 'Dockerfile', makefile: 'Makefile', '.prettierrc': 'JSON', '.eslintrc': 'JSON', '.babelrc': 'JSON', '.stylelintrc': 'JSON', '.swcrc': 'JSON', gemfile: 'Ruby', rakefile: 'Ruby', podfile: 'Ruby' }
    return map[ext] || map[name.toLowerCase()] || ''
  }

  function highlightCode(source, language) {
    const keywords = new Set('abstract and as async await break case catch class const continue def default defer delete do else enum export extends false final finally fn for from func function get go if implements import in instanceof interface is let match mod module namespace new nil none not null of or override package pass private protected protocol public raise readonly ref return select self set static struct super switch synchronized this throw trait true try type typeof undefined union unsafe use var virtual void where while with yield'.split(' '))
    const hashComments = ['Python', 'Ruby', 'Shell', 'PowerShell', 'YAML', 'TOML', 'R'].includes(language)
    const pattern = new RegExp(`/\\*[\\s\\S]*?\\*/|<!--[\\s\\S]*?-->|//[^\\n]*|${hashComments ? '#[^\\n]*|' : ''}<\\/?[A-Za-z][^>]*>|\"(?:\\\\.|[^\"\\\\])*\"|'(?:\\\\.|[^'\\\\])*'|\`(?:\\\\.|[^\`\\\\])*\`|\\b(?:0x[\\da-f]+|\\d+(?:\\.\\d+)?)\\b|\\b[A-Za-z_$][\\w$]*\\b`, 'gi')
    let output = '', cursor = 0
    source.replace(pattern, (token, offset) => {
      output += escapeHtml(source.slice(cursor, offset))
      const lower = token.toLowerCase(), cls = token.startsWith('//') || token.startsWith('/*') || token.startsWith('<!--') || (hashComments && token.startsWith('#')) ? 'comment' : token[0] === '"' || token[0] === "'" || token[0] === '`' ? 'string' : /^\d|^0x/i.test(token) ? 'number' : token[0] === '<' ? 'tag' : keywords.has(lower) ? 'keyword' : ''
      output += cls ? `<span class="tok-${cls}">${escapeHtml(token)}</span>` : escapeHtml(token)
      cursor = offset + token.length
      return token
    })
    return output + escapeHtml(source.slice(cursor))
  }

  function microsoftLabel(application) { return application === 'word' ? t('Open in Word', '用 Word 打开') : application === 'excel' ? t('Open in Excel', '用 Excel 打开') : t('Open in PowerPoint', '用 PowerPoint 打开') }
  function officeGlyph(application) { return `<span class="office-mark ${application}">${application === 'word' ? 'W' : application === 'excel' ? 'X' : 'P'}</span>` }
  function extension(name) { const match = name.toLowerCase().match(/\.([^.]+)$/); return match?.[1] || name.toLowerCase() }
  function fileType(name) { const ext = extension(name); return ext === name.toLowerCase() ? t('File', '文件') : ext.toUpperCase() }
  function fileIconClass(name) { const mode = classify(name).mode; return mode === 'text' ? 'code-file' : mode === 'image' ? 'image-file' : mode === 'pdf' ? 'pdf-file' : mode === 'audio' ? 'audio-file' : mode === 'office' ? 'office-file' : '' }
  function formatBytes(value) { const bytes = Number(value || 0); if (bytes < 1024) return `${bytes} B`; if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(bytes < 10240 ? 1 : 0)} KB`; return `${(bytes / 1024 ** 2).toFixed(bytes < 10 * 1024 ** 2 ? 1 : 0)} MB` }
  function pdfRenderDimension() { return Math.min(3200, Math.max(1200, Math.round(Math.max(innerWidth, innerHeight - 82) * Math.min(devicePixelRatio || 1, 2)))) }
  function revokePreviewUrl() { if (previewUrl) URL.revokeObjectURL(previewUrl); previewUrl = '' }
  function escapeHtml(value) { return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char])) }
  function escapeAttr(value) { return escapeHtml(value).replace(/`/g, '&#96;') }

  renderShell()
  parent.postMessage({ source: 'shun-plugin', channel, type: 'ready' }, '*')
  addEventListener('beforeunload', revokePreviewUrl)
})()
