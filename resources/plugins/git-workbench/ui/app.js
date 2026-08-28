(() => {
  const params = new URLSearchParams(location.search)
  const channel = params.get('channel') || ''
  const root = document.getElementById('app')
  const pending = new Map()
  let sequence = 0
  let workspaceRefreshTimer = 0
  let noticeDismissTimer = 0
  let lastScrollAt = 0
  let workspaceOverflow = false
  const workspacePaths = new Set()
  const state = { context: null, overview: null, unavailable: '', ref: '', selectedCommit: '', selectedFile: '', files: [], diff: '', preview: null, loading: true, detailLoading: false, diffLoading: false, error: '', query: '', graphRows: [], refsCollapsed: true, expandedRemotes: new Set(), remoteExpansionInitialized: false, skip: 0, overviewRequest: 0, detailRequest: 0, diffRequest: 0, busy: '', busyPath: '', refreshing: false, pendingRef: '', revealingPath: '', menu: null, dialog: null, notice: null }

  root.addEventListener('scroll', () => { lastScrollAt = performance.now() }, { capture: true, passive: true })
  addEventListener('keydown', event => {
    if (event.key !== 'Escape' || (!state.menu && !state.dialog)) return
    state.menu = null; state.dialog = null; render()
  })

  function scheduleWorkspaceRefresh(delay = 700, change) {
    if (change?.overflow) workspaceOverflow = true
    for (const path of change?.paths || []) workspacePaths.add(path)
    clearTimeout(workspaceRefreshTimer)
    workspaceRefreshTimer = setTimeout(() => {
      const remaining = 220 - (performance.now() - lastScrollAt)
      if (remaining > 0 || isPointerBusy()) return scheduleWorkspaceRefresh(Math.max(remaining, 180))
      const workspaceChange = { overflow: workspaceOverflow, paths: [...workspacePaths] }
      workspaceOverflow = false; workspacePaths.clear()
      void refreshOverview(workspaceChange)
    }, delay)
  }

  async function waitForUiIdle() {
    while (true) {
      const remaining = 160 - (performance.now() - lastScrollAt)
      if (remaining <= 0 && !isPointerBusy()) return
      await new Promise(resolve => setTimeout(resolve, Math.max(remaining, 120)))
    }
  }

  function isPointerBusy() { return Boolean(root.querySelector('.commit-list:hover, .files:hover')) }

  function request(method, payload = {}) {
    const requestId = `${Date.now()}-${++sequence}`
    parent.postMessage({ source: 'shun-plugin', channel, type: 'request', requestId, method, payload }, '*')
    return new Promise((resolve, reject) => pending.set(requestId, { resolve, reject }))
  }

  addEventListener('message', event => {
    const message = event.data
    if (!message || message.channel !== channel || message.source !== 'shun-host') return
    if (message.type === 'event' && message.event === 'workspace.changed') {
      scheduleWorkspaceRefresh(700, message.payload)
      return
    }
    if (message.type === 'context') {
      const changed = state.context?.workspace !== message.context?.workspace
      state.context = message.context
      applyTheme(message.context)
      if (changed) {
        resetWorkspaceState()
        if (message.context?.workspace) void loadOverview('HEAD', true)
      }
      return
    }
    if (message.type === 'response') {
      const waiter = pending.get(message.requestId)
      if (!waiter) return
      pending.delete(message.requestId)
      if (message.error) waiter.reject(new Error(message.error))
      else waiter.resolve(message.result)
    }
  })

  async function loadOverview(ref = state.ref, reset = true, preserveDetail = false, workspaceChange = null) {
    if (!state.context?.workspace) return
    const requestVersion = ++state.overviewRequest
    const background = preserveDetail && !!state.overview
    state.loading = true; state.error = ''; state.unavailable = ''; state.ref = ref
    if (reset) state.skip = 0
    if (!background) render(reset ? ['commits'] : [])
    try {
      const result = await request('git.overview', { ref, skip: state.skip, limit: 180 })
      if (requestVersion !== state.overviewRequest) return
      if (result?.unavailable === 'not-repository') {
        state.loading = false; state.unavailable = 'not-repository'; state.overview = null; state.error = ''
        state.selectedCommit = ''; state.selectedFile = ''; state.files = []; state.diff = ''; state.preview = null; state.graphRows = []
        render(); return
      }
      state.unavailable = ''
      if (ref === 'HEAD') state.ref = result.refs.find(item => item.kind === 'branch' && item.current)?.fullName || 'HEAD'
      if (!state.remoteExpansionInitialized) {
        for (const remote of result.remotes) state.expandedRemotes.add(remote.name)
        state.remoteExpansionInitialized = true
      }
      const historyUnchanged = background && historyFingerprint(state.overview) === historyFingerprint(result)
      if (historyUnchanged && workspaceChange) {
        state.overview = result; state.loading = false
        const selectedChanged = workspaceChange.overflow || workspaceChange.paths.some(path => path === state.selectedFile || path.startsWith(`${state.selectedFile}/`) || state.selectedFile.startsWith(`${path}/`))
        if (state.selectedCommit === 'WORKTREE') {
          state.files = workingFiles(result)
          if (!state.files.some(file => file.path === state.selectedFile)) { state.selectedFile = ''; state.diff = ''; state.preview = null }
          patchWorkingTreeView()
          const selected = state.files.find(file => file.path === state.selectedFile)
          if (selectedChanged && selected) void loadFile(selected.path, true, selected.status, true)
        } else patchRepositorySummary()
        return
      }
      const unchanged = background && overviewFingerprint(state.overview) === overviewFingerprint(result)
      const workingDiffMayHaveChanged = state.selectedCommit === 'WORKTREE' && Boolean(state.selectedFile)
      if (unchanged && !workingDiffMayHaveChanged) {
        state.overview = result
        state.loading = false
        return
      }
      if (background) await waitForUiIdle()
      if (requestVersion !== state.overviewRequest) return
      state.overview = reset || !state.overview ? result : { ...result, commits: [...state.overview.commits, ...result.commits] }
      state.graphRows = graphLayout(state.overview.commits)
      state.loading = false
      if (reset && !preserveDetail) {
        state.selectedCommit = state.overview.repository.files.length ? 'WORKTREE' : state.overview.commits[0]?.oid || ''
        state.selectedFile = ''; state.files = []; state.diff = ''; state.preview = null
        if (state.selectedCommit === 'WORKTREE') void loadWorking()
        else if (state.selectedCommit) void loadCommit(state.selectedCommit)
      } else if (reset && state.selectedCommit === 'WORKTREE') {
        state.files = workingFiles(state.overview)
        const selected = state.files.find(file => file.path === state.selectedFile)
        if (!selected) { state.selectedFile = ''; state.diff = ''; state.preview = null }
        else void loadFile(selected.path, true, selected.status)
      } else if (reset && state.selectedCommit && !state.overview.commits.some(commit => commit.oid === state.selectedCommit)) {
        state.selectedCommit = state.overview.commits[0]?.oid || ''
        state.selectedFile = ''; state.files = []; state.diff = ''; state.preview = null
        if (state.selectedCommit) void loadCommit(state.selectedCommit)
      }
      render()
    } catch (error) { if (requestVersion === state.overviewRequest) { state.loading = false; state.error = error.message || String(error); render() } }
  }

  function resetWorkspaceState() {
    clearTimeout(workspaceRefreshTimer); workspaceRefreshTimer = 0; clearTimeout(noticeDismissTimer); noticeDismissTimer = 0; workspaceOverflow = false; workspacePaths.clear()
    state.overviewRequest++; state.detailRequest++; state.diffRequest++
    state.overview = null; state.unavailable = ''; state.ref = ''; state.selectedCommit = ''; state.selectedFile = ''
    state.files = []; state.diff = ''; state.preview = null; state.loading = true; state.detailLoading = false; state.diffLoading = false
    state.error = ''; state.query = ''; state.graphRows = []; state.expandedRemotes.clear(); state.remoteExpansionInitialized = false; state.skip = 0; state.busy = ''; state.busyPath = ''; state.refreshing = false; state.pendingRef = ''; state.revealingPath = ''; state.menu = null; state.dialog = null; state.notice = null
    render()
  }

  function applyTheme(context) {
    const theme = context?.theme === 'light' || (context?.theme === 'system' && matchMedia('(prefers-color-scheme: light)').matches) ? 'light' : 'dark'
    document.documentElement.dataset.theme = theme
    document.documentElement.style.colorScheme = theme
    const map = { accent: 'accent', 'app-bg': 'bg', 'sidebar-bg': 'sidebar', 'surface-1': 'panel', 'surface-2': 'raised', 'surface-3': 'surface', 'border-1': 'line', 'border-2': 'line-strong', 'text-1': 'text', 'text-2': 'text-secondary', 'text-3': 'muted', 'text-4': 'faint', 'hover-bg': 'hover', 'sidebar-item-selected': 'selected', 'code-bg': 'code-bg' }
    for (const [source, target] of Object.entries(map)) {
      const value = context?.themeTokens?.[source]
      if (value) document.documentElement.style.setProperty(`--${target}`, value)
    }
  }

  async function refreshOverview(workspaceChange = { overflow: true, paths: [] }) { await loadOverview(state.ref, true, true, workspaceChange) }

  async function refreshFromControl() {
    if (state.refreshing) return
    state.refreshing = true; render()
    try { await refreshOverview() } finally { state.refreshing = false; render() }
  }

  async function loadRef(ref) {
    if (state.pendingRef) return
    state.pendingRef = ref; render()
    try { await loadOverview(ref, true) } finally { state.pendingRef = ''; render() }
  }

  async function loadMore() { state.skip = state.overview?.commits.length || 0; await loadOverview(state.ref, false) }

  async function loadCommit(oid) {
    const requestVersion = ++state.detailRequest
    state.selectedCommit = oid; state.selectedFile = ''; state.files = []; state.diff = ''; state.preview = null; state.detailLoading = true; render(['files', 'diff'])
    try {
      const result = await request('git.commitFiles', { revision: oid })
      if (state.selectedCommit !== oid || requestVersion !== state.detailRequest) return
      state.files = result.files; state.detailLoading = false
      if (state.files[0]) void loadFile(state.files[0].path, false, state.files[0].status)
      render()
    } catch (error) { if (requestVersion === state.detailRequest) { state.detailLoading = false; state.error = error.message || String(error); render() } }
  }

  async function loadWorking() {
    state.detailRequest++
    state.selectedCommit = 'WORKTREE'; state.selectedFile = ''; state.diff = ''; state.preview = null; state.detailLoading = false
    state.files = workingFiles(state.overview)
    render()
    if (state.files[0]) void loadFile(state.files[0].path, true, state.files[0].status)
  }

  function loadFile(path, working, status, silent = false) {
    if (previewableImage(path)) return loadImagePreview(path, working, status, silent)
    return loadDiff(path, working, silent)
  }

  async function loadImagePreview(path, working, status, silent = false) {
    const requestVersion = ++state.diffRequest, expectedCommit = state.selectedCommit
    state.selectedFile = path; state.diffLoading = true
    if (!silent) { state.diff = ''; state.preview = null; render(['diff']) }
    try {
      const result = await request('git.filePreview', { path, working, status, ...(!working ? { revision: state.selectedCommit } : {}) })
      if (state.selectedFile !== path || state.selectedCommit !== expectedCommit || requestVersion !== state.diffRequest) return
      if (silent && state.preview?.data === result?.data) { state.diffLoading = false; return }
      state.diff = ''; state.preview = result; state.diffLoading = false
      if (silent) patchDiff()
      else render(['diff'])
    } catch (error) {
      if (requestVersion !== state.diffRequest) return
      state.diff = ''; state.preview = { kind: 'unavailable', message: friendlyError(error) }; state.diffLoading = false
      if (silent) patchDiff()
      else render(['diff'])
    }
  }

  async function loadDiff(path, working, silent = false) {
    const requestVersion = ++state.diffRequest, expectedCommit = state.selectedCommit
    state.selectedFile = path; state.preview = null; state.diffLoading = true
    if (!silent) { state.diff = ''; render(['diff']) }
    try {
      const result = await request('git.diff', { path, working, ...(!working ? { revision: state.selectedCommit } : {}) })
      if (state.selectedFile !== path || state.selectedCommit !== expectedCommit || requestVersion !== state.diffRequest) return
      const nextDiff = String(result || '')
      if (silent && nextDiff === state.diff) { state.diffLoading = false; return }
      state.diff = nextDiff; state.diffLoading = false
      if (silent) patchDiff()
      else render(['diff'])
    } catch (error) { if (requestVersion === state.diffRequest) { state.diffLoading = false; state.error = error.message || String(error); render() } }
  }

  function patchRepositorySummary() {
    const row = root.querySelector('[data-worktree]')
    if (row) {
      const template = document.createElement('template'); template.innerHTML = renderWorkingRow(state.overview, state.context.language === 'zh')
      row.replaceWith(template.content.firstElementChild)
      root.querySelector('[data-worktree]')?.addEventListener('click', () => void loadWorking())
    }
    const remote = root.querySelector('.history-head small')
    if (remote) remote.textContent = `${state.overview.repository.behind ? `↓${state.overview.repository.behind}` : ''}${state.overview.repository.ahead ? ` ↑${state.overview.repository.ahead}` : ''}`
  }

  function patchWorkingTreeView() {
    patchRepositorySummary()
    const zh = state.context.language === 'zh', files = root.querySelector('.files')
    if (files) {
      const top = files.scrollTop
      files.innerHTML = renderFileList(zh, true)
      files.scrollTop = top
      bindFiles(files)
    }
    const meta = root.querySelector('.commit-meta')
    if (meta) meta.innerHTML = `<h2>${zh ? '工作区变更' : 'Workspace changes'}</h2><p><code>${state.files.length} ${zh ? '个文件' : 'files'}</code></p>`
    if (!state.selectedFile) patchDiff()
  }

  function patchDiff() {
    const diff = root.querySelector('.diff')
    if (!diff) return
    const top = diff.scrollTop, left = diff.scrollLeft
    diff.innerHTML = renderDetailContent(state.context.language === 'zh')
    diff.scrollTop = top; diff.scrollLeft = left
    bindReveal(diff)
  }

  async function executeGit(action, payload = {}) {
    if (state.busy) return
    clearTimeout(noticeDismissTimer); noticeDismissTimer = 0
    state.menu = null; state.dialog = null; state.busy = action; state.busyPath = payload.paths?.[0] || ''; state.notice = null; render()
    try {
      const result = await request('git.execute', { action, ...payload })
      const generic = !result?.message || result.message === `${action} completed.`
      const message = generic ? actionCompletedLabel(action, state.context.language === 'zh') : result.message
      const nextFile = action === 'reset-file' ? optimisticallyDiscardFiles(payload.paths || []) : null
      state.busy = ''; state.busyPath = ''; showNotice(message, 'success')
      if (nextFile) void loadFile(nextFile.path, true, nextFile.status)
      void loadOverview(action === 'checkout' || action === 'create-branch' ? 'HEAD' : (state.ref || 'HEAD'), true, true)
    } catch (error) {
      state.busy = ''; state.busyPath = ''; showNotice(friendlyError(error), 'error')
    }
  }

  function optimisticallyDiscardFiles(paths) {
    if (!state.overview || !paths.length) return null
    const discarded = new Set(paths)
    state.overview = { ...state.overview, repository: { ...state.overview.repository, files: state.overview.repository.files.filter(file => !discarded.has(file.path)) } }
    if (state.selectedCommit !== 'WORKTREE') return null
    state.files = state.files.filter(file => !discarded.has(file.path))
    if (!discarded.has(state.selectedFile)) return null
    state.selectedFile = ''; state.diff = ''; state.preview = null; state.diffLoading = false
    return state.files[0] || null
  }

  function actionProgressLabel(action, zh) {
    const labels = zh ? {
      commit: '正在提交…', pull: '正在拉取当前分支…', push: '正在推送当前分支…', fetch: '正在获取远程更新…',
      'create-branch': '正在创建分支…', merge: '正在合并…', stash: '正在贮藏…', checkout: '正在切换分支…', reset: '正在重置分支…', 'reset-file': '正在丢弃文件改动…',
      stage: '正在暂存文件…', unstage: '正在取消暂存…', tag: '正在创建标签…', 'cherry-pick': '正在 Cherry-pick…', revert: '正在还原提交…',
    } : {
      commit: 'Committing…', pull: 'Pulling current branch…', push: 'Pushing current branch…', fetch: 'Fetching remote updates…',
      'create-branch': 'Creating branch…', merge: 'Merging…', stash: 'Stashing…', checkout: 'Switching branch…', reset: 'Resetting branch…', 'reset-file': 'Discarding file changes…',
      stage: 'Staging file…', unstage: 'Unstaging file…', tag: 'Creating tag…', 'cherry-pick': 'Cherry-picking…', revert: 'Reverting commit…',
    }
    return labels[action] || (zh ? '正在执行 Git 操作…' : 'Running Git operation…')
  }

  function actionCompletedLabel(action, zh) {
    if (action === 'fetch') return zh ? '已获取远程更新' : 'Remote updates fetched'
    if (action === 'stage') return zh ? '文件已暂存' : 'File staged'
    if (action === 'unstage') return zh ? '已取消暂存' : 'File unstaged'
    if (action === 'reset-file') return zh ? '文件改动已丢弃' : 'File changes discarded'
    return zh ? 'Git 操作已完成' : 'Git operation completed'
  }

  function renderActivity(zh) {
    if (state.busy) return `<div class="notice progress" role="status" aria-live="assertive"><i class="spinner"></i><span>${escapeHtml(actionProgressLabel(state.busy, zh))}</span></div>`
    return state.notice ? `<button class="notice ${state.notice.kind}" data-notice-close title="${zh ? '关闭' : 'Dismiss'}">${escapeHtml(state.notice.message)}</button>` : ''
  }

  function openDialog(action, options = {}) {
    state.menu = null
    state.dialog = { action, value: options.value || '', ref: options.ref || '', paths: options.paths || [], title: options.title || action, label: options.label || '', description: options.description || '', options: options.options || [], danger: Boolean(options.danger), submitLabel: options.submitLabel || '' }
    render()
  }

  function submitDialog() {
    const dialog = state.dialog
    if (!dialog || (dialog.label && !dialog.value.trim())) return
    const payload = {}
    if (['commit', 'stash'].includes(dialog.action)) payload.message = dialog.value
    if (dialog.action === 'create-branch' || dialog.action === 'tag') { payload.name = dialog.value; if (dialog.ref) payload.ref = dialog.ref }
    if (dialog.action === 'merge') payload.ref = dialog.value
    if (dialog.action === 'reset') { payload.ref = dialog.ref; payload.mode = dialog.value }
    if (dialog.action === 'reset-file') payload.paths = dialog.paths
    if (dialog.action === 'cherry-pick' || dialog.action === 'revert') payload.ref = dialog.ref
    void executeGit(dialog.action, payload)
  }

  function handleToolbar(action, zh) {
    const o = state.overview, staged = o.repository.files.filter(file => file.staged).length
    if (action === 'fetch') return void executeGit('fetch')
    if (action === 'pull' || action === 'push') return openDialog(action, { title: action === 'pull' ? (zh ? '拉取当前分支' : 'Pull current branch') : (zh ? '推送当前分支' : 'Push current branch'), description: action === 'pull' ? (zh ? '仅执行 fast-forward 拉取；分支发生分叉时不会自动合并。' : 'Fast-forward only. Diverged branches will not be merged automatically.') : (zh ? `推送 ${o.repository.head}${o.repository.ahead ? `（领先 ${o.repository.ahead} 个提交）` : ''}。` : `Push ${o.repository.head}${o.repository.ahead ? ` (${o.repository.ahead} commits ahead)` : ''}.`) })
    if (action === 'commit') return staged ? openDialog('commit', { title: zh ? '提交暂存的更改' : 'Commit staged changes', label: zh ? '提交信息' : 'Commit message', description: zh ? `${staged} 个文件已暂存。` : `${staged} staged files.` }) : (void loadWorking(), showNotice(zh ? '请先在文件右键菜单中暂存需要提交的文件。' : 'Stage files from the file context menu before committing.'))
    if (action === 'stash') return openDialog('stash', { title: zh ? '暂存工作区' : 'Stash workspace', label: zh ? '说明' : 'Message', value: 'Git Workbench stash', description: zh ? '包含未跟踪文件。' : 'Untracked files will be included.' })
    if (action === 'create-branch') return openDialog('create-branch', { title: zh ? '创建并切换分支' : 'Create and switch branch', label: zh ? '分支名称' : 'Branch name' })
    if (action === 'merge') {
      const options = o.refs.filter(ref => (ref.kind === 'branch' || ref.kind === 'remote-branch') && !ref.current).map(ref => ({ value: ref.fullName, label: ref.name }))
      return openDialog('merge', { title: zh ? '合并到当前分支' : 'Merge into current branch', label: zh ? '来源分支' : 'Source branch', value: options[0]?.value || '', options, description: zh ? `目标分支：${o.repository.head}` : `Target branch: ${o.repository.head}` })
    }
  }

  function showNotice(message, kind = 'info') {
    clearTimeout(noticeDismissTimer)
    const notice = { kind, message }
    state.notice = notice; render()
    if (kind === 'error') { noticeDismissTimer = 0; return }
    noticeDismissTimer = setTimeout(() => {
      noticeDismissTimer = 0
      if (state.notice !== notice) return
      state.notice = null; render()
    }, 2600)
  }

  function dismissNotice() {
    clearTimeout(noticeDismissTimer); noticeDismissTimer = 0
    if (!state.notice) return
    state.notice = null; render()
  }

  async function initializeRepository() {
    const zh = state.context?.language === 'zh'
    clearTimeout(noticeDismissTimer); noticeDismissTimer = 0
    state.busy = 'init'; state.notice = null; render()
    try {
      const result = await request('git.execute', { action: 'init' })
      state.busy = ''; state.unavailable = ''
      await loadOverview('HEAD', true)
      showNotice(result?.message || (zh ? 'Git 仓库已初始化' : 'Git repository initialized'), 'success')
    } catch (error) {
      state.busy = ''; showNotice(error.message || String(error), 'error')
    }
  }

  function render(resetScroll = []) {
    if (!state.context) return stateView('Connecting to plugin host…')
    if (state.loading && !state.overview) return stateView('Loading repository…', true)
    if (state.unavailable === 'not-repository') return renderRepositoryUnavailable()
    if (state.error && !state.overview) return stateView(state.error, false, true)
    const o = state.overview
    if (!o) return
    const zh = state.context.language === 'zh'
    const commits = filteredCommits(o.commits, state.query)
    const scroll = new Map([...root.querySelectorAll('[data-scroll]')].map(element => [element.dataset.scroll, { top: element.scrollTop, left: element.scrollLeft }]))
    const search = root.querySelector('.search input')
    const restoreSearch = search === document.activeElement ? { start: search.selectionStart, end: search.selectionEnd } : null
    root.innerHTML = `<section class="workbench">
      <div class="toolbar"><button class="refs-toggle" data-action="toggle-refs" aria-expanded="${!state.refsCollapsed}" title="${state.refsCollapsed ? (zh ? '展开 Git 导航' : 'Show Git navigation') : (zh ? '收起 Git 导航' : 'Hide Git navigation')}" aria-label="${state.refsCollapsed ? (zh ? '展开 Git 导航' : 'Show Git navigation') : (zh ? '收起 Git 导航' : 'Hide Git navigation')}">${gitIcon('sidebar')}</button><span class="brand"><strong title="${escapeAttr(o.repository.root)}">${escapeHtml(o.repository.root.split('/').pop())}</strong><small title="${escapeAttr(o.repository.head)}">${escapeHtml(o.repository.head || (zh ? '未命名分支' : 'unnamed branch'))}</small></span>${renderOperations(o, zh)}<label class="search">${gitIcon('search')}<input value="${escapeAttr(state.query)}" placeholder="${zh ? '搜索提交' : 'Search commits'}" aria-label="${zh ? '搜索提交' : 'Search commits'}"></label><button class="refresh ${state.refreshing ? 'is-pending' : ''}" data-action="refresh" ${state.refreshing ? 'disabled aria-busy="true"' : ''} title="${state.refreshing ? (zh ? '正在刷新…' : 'Refreshing…') : (zh ? '刷新' : 'Refresh')}" aria-label="${zh ? '刷新' : 'Refresh'}">${state.refreshing ? loadingRing('control-spinner') : gitIcon('refresh')}</button></div>
      <div class="body ${state.refsCollapsed ? 'refs-collapsed' : ''}">
        ${state.refsCollapsed ? '' : `<nav class="refs" data-scroll="refs">${renderRefs(o, zh)}</nav>`}
        <section class="history"><div class="history-head"><span>${state.ref ? escapeHtml(shortRef(state.ref)) : (zh ? '所有分支' : 'All branches')} · ${commits.length}</span>${o.repository.upstream ? `<small>${o.repository.behind ? `↓${o.repository.behind}` : ''}${o.repository.ahead ? ` ↑${o.repository.ahead}` : ''}</small>` : ''}</div><div class="commit-list" data-scroll="commits">${renderWorkingRow(o, zh)}${commits.map(commit => renderCommit(commit, state.graphRows[o.commits.indexOf(commit)], zh)).join('')}${!commits.length ? `<div class="empty-list">${zh ? '没有匹配提交' : 'No matching commits'}</div>` : ''}${o.hasMore && !state.query ? `<button class="load-more" data-action="more">${zh ? '加载更多' : 'Load more'}</button>` : ''}</div></section>
        <section class="details">${renderDetails(zh)}</section>
      </div>
      ${renderContextMenu(zh)}${renderDialog(zh)}${renderActivity(zh)}
    </section>`
    bind()
    for (const element of root.querySelectorAll('[data-scroll]')) {
      if (resetScroll.includes(element.dataset.scroll)) continue
      const position = scroll.get(element.dataset.scroll)
      if (position) { element.scrollTop = position.top; element.scrollLeft = position.left }
    }
    if (restoreSearch) {
      const input = root.querySelector('.search input')
      input?.focus({ preventScroll: true })
      input?.setSelectionRange(restoreSearch.start, restoreSearch.end)
    }
    positionContextMenu()
  }

  function renderRepositoryUnavailable() {
    const zh = state.context.language === 'zh', canWrite = state.context.permissions?.includes('workspace.git.write')
    const workspace = state.context.workspace || '', name = workspace.split(/[\\/]/).filter(Boolean).pop() || (zh ? '当前目录' : 'Current folder')
    root.innerHTML = `<section class="repository-unavailable">
      <div class="repository-unavailable-content">
        <span class="repository-unavailable-icon">${gitIcon('branch')}</span>
        <small>${escapeHtml(name)}</small>
        <h1>${zh ? '这里还不是 Git 仓库' : 'This workspace is not a Git repository'}</h1>
        <p>${zh ? '初始化后，Git Workbench 会在这里显示未提交更改、分支、提交历史和文件差异。' : 'Initialize it to inspect uncommitted changes, branches, commit history, and file diffs here.'}</p>
        <div class="repository-unavailable-actions">
          ${canWrite ? `<button class="primary ${state.busy === 'init' ? 'is-pending' : ''}" data-empty-action="init" ${state.busy ? 'disabled' : ''}>${state.busy === 'init' ? loadingRing('control-spinner') : gitIcon('commit')}${state.busy === 'init' ? (zh ? '正在初始化…' : 'Initializing…') : (zh ? '初始化 Git 仓库' : 'Initialize Git repository')}</button>` : ''}
          <button data-empty-action="retry" ${state.busy ? 'disabled' : ''}>${gitIcon('refresh')}${zh ? '重新检测' : 'Check again'}</button>
          <button data-reveal=".">${gitIcon('reveal')}${zh ? '在文件系统中显示' : 'Show in file browser'}</button>
        </div>
        ${!canWrite ? `<em>${zh ? '初始化需要 Git 写入权限。' : 'Git write permission is required to initialize this workspace.'}</em>` : ''}
      </div>
      ${state.notice ? `<button class="notice ${state.notice.kind}" data-notice-close title="${zh ? '关闭' : 'Dismiss'}">${escapeHtml(state.notice.message)}</button>` : ''}
    </section>`
    root.querySelector('[data-empty-action="init"]')?.addEventListener('click', () => void initializeRepository())
    root.querySelector('[data-empty-action="retry"]')?.addEventListener('click', () => void loadOverview('HEAD', true))
    root.querySelector('[data-notice-close]')?.addEventListener('click', dismissNotice)
    bindReveal(root)
  }

  function renderOperations(o, zh) {
    const canWrite = state.context.permissions?.includes('workspace.git.write')
    if (!canWrite) return `<div class="operations-unavailable">${gitIcon('refresh')}<span><b>${zh ? 'Git 操作尚未启用' : 'Git actions are not enabled'}</b><small>${zh ? '重启 Shun 以完成插件更新' : 'Restart Shun to finish the plugin update'}</small></span></div>`
    const groups = [
      [['commit', 'commit', zh ? '提交' : 'Commit']],
      [['pull', 'pull', zh ? '拉取' : 'Pull'], ['push', 'push', zh ? '推送' : 'Push'], ['fetch', 'fetch', zh ? '获取' : 'Fetch']],
      [['create-branch', 'branch', zh ? '分支' : 'Branch'], ['merge', 'merge', zh ? '合并' : 'Merge'], ['stash', 'stash', zh ? '贮藏' : 'Stash']],
    ]
    const button = ([action, icon, label]) => {
      const running = state.busy === action
      return `<button class="${running ? 'running is-pending' : ''}" data-command="${action}" ${state.busy ? 'disabled' : ''} title="${running ? actionProgressLabel(action, zh) : label}" ${running ? 'aria-busy="true"' : ''}><i>${running ? loadingRing('operation-spinner') : gitIcon(icon)}</i><span>${label}</span>${action === 'push' && o.repository.ahead ? `<em>${o.repository.ahead}</em>` : ''}</button>`
    }
    return `<nav class="operations" aria-label="${zh ? 'Git 操作' : 'Git actions'}">${groups.map(group => `<span class="operation-group">${group.map(button).join('')}</span>`).join('')}</nav>`
  }

  function gitIcon(name) {
    const paths = {
      search: '<circle cx="7" cy="7" r="4"/><path d="m10 10 3 3"/>',
      refresh: '<path d="M13 5V2l-2 2A5.5 5.5 0 1 0 13 9"/>',
      busy: '<path d="M8 2a6 6 0 0 1 6 6"/>',
      commit: '<circle cx="8" cy="8" r="3"/><path d="M8 2v3M8 11v3"/>',
      pull: '<path d="M8 2v9M4.5 8 8 11.5 11.5 8"/><path d="M3 14h10"/>',
      push: '<path d="M8 14V5M4.5 8 8 4.5 11.5 8"/><path d="M3 2h10"/>',
      fetch: '<path d="M12.5 5.5A5 5 0 1 0 13 10"/><path d="M12.5 2.5v3h-3"/>',
      branch: '<circle cx="5" cy="4" r="1.5"/><circle cx="11" cy="5" r="1.5"/><circle cx="5" cy="12" r="1.5"/><path d="M5 5.5v5M10 6.2c0 2.3-1.5 3-5 3"/>',
      merge: '<circle cx="5" cy="4" r="1.5"/><circle cx="11" cy="4" r="1.5"/><circle cx="8" cy="12" r="1.5"/><path d="M5 5.5v1.2c0 1.5 1 2.2 3 3.8M11 5.5v1.2c0 1.5-1 2.2-3 3.8"/>',
      stash: '<path d="M3 5h10v8H3zM2 3h12"/><path d="M6 8h4"/>',
      sidebar: '<rect x="2.5" y="2.5" width="11" height="11" rx="2"/><path d="M6 2.5v11"/>',
      chevron: '<path d="m5.5 6.5 2.5 2.5 2.5-2.5"/>',
      remote: '<path d="M5.5 12.5h6.5a2.5 2.5 0 0 0 .2-5A4.2 4.2 0 0 0 4.4 6a3.3 3.3 0 0 0 1.1 6.5Z"/>',
      checked: '<rect x="2.5" y="2.5" width="11" height="11" rx="2.5"/><path d="m5 8 2 2 4-4"/>',
      unchecked: '<rect x="2.5" y="2.5" width="11" height="11" rx="2.5"/>',
      more: '<circle cx="4" cy="8" r="1" fill="currentColor" stroke="none"/><circle cx="8" cy="8" r="1" fill="currentColor" stroke="none"/><circle cx="12" cy="8" r="1" fill="currentColor" stroke="none"/>',
      reveal: '<path d="M2.5 4.5h4l1.2 1.5h5.8v7h-11z"/><path d="m9.5 9 3-3m-3 0h3v3"/>',
      image: '<rect x="2.5" y="3" width="11" height="10" rx="1.5"/><circle cx="6" cy="6.5" r="1"/><path d="m4 11 2.5-2.5 2 2L10 9l2 2"/>',
    }
    return `<svg class="icon" viewBox="0 0 16 16" aria-hidden="true">${paths[name] || ''}</svg>`
  }

  function loadingRing(className = '') { return `<span class="spinner${className ? ` ${className}` : ''}" aria-hidden="true"></span>` }

  function renderWorkingRow(o, zh) {
    const files = o.repository.files, staged = files.filter(file => file.staged).length, unstaged = files.filter(file => file.unstaged || file.untracked).length
    return `<button class="commit working ${state.selectedCommit === 'WORKTREE' ? 'active' : ''}" data-worktree><svg class="graph" viewBox="0 0 52 32" aria-hidden="true"><circle cx="7" cy="16" r="3.2" fill="${files.length ? 'var(--orange)' : 'var(--faint)'}" stroke="var(--bg)" stroke-width="1.5"/></svg><span class="commit-copy"><b>${zh ? '未提交的更改' : 'Uncommitted changes'}</b><span class="badges"><i class="badge working-badge">${files.length} ${zh ? '个文件' : 'files'}</i></span><small>${staged ? `<span>${zh ? '已暂存' : 'staged'} ${staged}</span>` : ''}${unstaged ? `<span>${zh ? '未暂存' : 'unstaged'} ${unstaged}</span>` : ''}</small></span></button>`
  }

  function renderRefs(o, zh) {
    const groups = [
      [zh ? '工作区' : 'Workspace', [{ name: zh ? '文件状态' : 'File status', fullName: 'WORKTREE', current: state.selectedCommit === 'WORKTREE' }]],
      [zh ? '分支' : 'Branches', o.refs.filter(ref => ref.kind === 'branch')],
      [zh ? '标签' : 'Tags', o.refs.filter(ref => ref.kind === 'tag')],
    ]
    const local = groups.map(([title, items]) => `<section class="ref-section"><div class="ref-title">${title}<em>${items.length}</em></div>${items.map(ref => `<button class="ref-item ${ref.current ? 'current' : ''} ${state.ref === ref.fullName || (ref.fullName === 'WORKTREE' && state.selectedCommit === 'WORKTREE') ? 'active' : ''} ${state.pendingRef === ref.fullName ? 'is-pending' : ''}" data-ref="${escapeAttr(ref.fullName)}" ${state.pendingRef === ref.fullName ? 'aria-busy="true"' : ''}>${state.pendingRef === ref.fullName ? loadingRing('ref-spinner') : '<i class="ref-dot"></i>'}<span>${escapeHtml(ref.name)}</span></button>`).join('')}</section>`).join('')
    const remotes = `<section class="ref-section remote-section"><div class="ref-title">${zh ? '远程' : 'Remotes'}<em>${o.remotes.length}</em></div>${o.remotes.map(remote => {
      const expanded = state.expandedRemotes.has(remote.name)
      const branches = o.refs.filter(ref => ref.kind === 'remote-branch' && ref.name.startsWith(`${remote.name}/`) && !ref.name.endsWith('/HEAD'))
      return `<div class="remote-tree"><button class="remote-root" data-remote-toggle="${escapeAttr(remote.name)}" aria-expanded="${expanded}" title="${escapeAttr(remote.fetchUrl || remote.name)}"><i class="remote-chevron">${gitIcon('chevron')}</i>${gitIcon('remote')}<span>${escapeHtml(remote.name)}</span><em>${branches.length}</em></button>${expanded ? `<div class="remote-children">${branches.map(ref => `<button class="ref-item remote-branch ${state.ref === ref.fullName ? 'active' : ''} ${state.pendingRef === ref.fullName ? 'is-pending' : ''}" data-ref="${escapeAttr(ref.fullName)}" ${state.pendingRef === ref.fullName ? 'aria-busy="true"' : ''} title="${escapeAttr(ref.name)}">${state.pendingRef === ref.fullName ? loadingRing('ref-spinner') : '<i class="ref-dot"></i>'}<span>${escapeHtml(ref.name.slice(remote.name.length + 1))}</span></button>`).join('') || `<div class="remote-empty">${zh ? '没有远程分支' : 'No remote branches'}</div>`}</div>` : ''}</div>`
    }).join('')}</section>`
    return local + remotes
  }

  function renderCommit(commit, graph, zh) {
    const selected = commit.oid === state.selectedCommit
    const subject = commit.subject || (zh ? '无提交说明' : 'No commit message')
    const refs = [...new Map(commit.refs.map(value => {
      const label = cleanDecoration(value)
      return [label, { label, kind: decorationKind(value) }]
    }).filter(([label]) => Boolean(label))).values()]
    const visibleRefs = refs.slice(0, 4), hiddenRefs = refs.slice(4)
    const badges = refs.length ? `<span class="badges" title="${escapeAttr(refs.map(ref => ref.label).join(' · '))}">${visibleRefs.map(ref => `<i class="badge ${ref.kind}">${escapeHtml(ref.label)}</i>`).join('')}${hiddenRefs.length ? `<i class="badge more" title="${escapeAttr(hiddenRefs.map(ref => ref.label).join(' · '))}">+${hiddenRefs.length}</i>` : ''}</span>` : ''
    return `<button class="commit ${selected ? 'active' : ''} ${selected && state.detailLoading ? 'is-pending' : ''}" data-commit="${commit.oid}" ${selected && state.detailLoading ? 'aria-busy="true"' : ''}>${selected && state.detailLoading ? `<span class="graph-loading">${loadingRing('graph-spinner')}</span>` : renderGraph(graph)}<span class="commit-copy"><b title="${escapeAttr(subject)}">${escapeHtml(subject)}</b>${badges}<small><span title="${escapeAttr(commit.authorName)}">${escapeHtml(commit.authorName)}</span><code>${commit.oid.slice(0, 7)}</code><span>${relativeDate(commit.authoredAt, zh)}</span></small></span></button>`
  }

  function renderDetails(zh) {
    const o = state.overview
    const working = state.selectedCommit === 'WORKTREE'
    const commit = working ? null : o.commits.find(item => item.oid === state.selectedCommit)
    const heading = working ? (zh ? '工作区变更' : 'Workspace changes') : commit?.subject || (zh ? '选择提交' : 'Select a commit')
    const meta = working ? `${state.files.length} ${zh ? '个文件' : 'files'}` : commit ? `${commit.authorName} · ${fullDate(commit.authoredAt, zh)} · ${commit.oid}` : ''
    return `<div class="commit-meta"><h2>${escapeHtml(heading)}</h2><p><code>${escapeHtml(meta)}</code></p></div><div class="detail-body"><nav class="files" data-scroll="files">${renderFileList(zh, working)}</nav><div class="diff" data-scroll="diff">${state.diffLoading ? `<div class="state"><span><i class="spinner"></i>${zh ? '读取内容…' : 'Loading content…'}</span></div>` : renderDetailContent(zh)}</div></div>`
  }

  function renderFileList(zh, working) {
    if (state.detailLoading) return `<div class="state"><span><i class="spinner"></i>${zh ? '读取文件…' : 'Loading files…'}</span></div>`
    return state.files.map(file => {
      const selected = file.path === state.selectedFile, status = file.status[0] || 'M', staged = Boolean(file.staged)
      const separator = file.path.lastIndexOf('/')
      const directory = separator >= 0 ? file.path.slice(0, separator + 1) : ''
      const fileName = separator >= 0 ? file.path.slice(separator + 1) : file.path
      const data = `data-path="${escapeAttr(file.path)}" data-working="${working}" data-status="${escapeAttr(file.status)}" data-staged="${staged}"`
      const menuLabel = zh ? `${file.path} 的文件操作` : `Actions for ${file.path}`
      const fileActionPending = working && state.busyPath === file.path && (state.busy === 'stage' || state.busy === 'unstage' || state.busy === 'reset-file')
      return `<div class="file-row ${selected ? 'active' : ''} ${selected && state.diffLoading ? 'is-pending' : ''} ${working ? 'working-file' : 'commit-file'}">
        ${working ? `<button class="file-stage ${fileActionPending ? 'is-pending' : ''}" data-stage-file ${data} role="checkbox" aria-checked="${staged}" ${state.busy ? 'disabled' : ''} ${fileActionPending ? 'aria-busy="true"' : ''} title="${fileActionPending ? actionProgressLabel(state.busy, zh) : (staged ? (zh ? '取消暂存' : 'Unstage file') : (zh ? '暂存文件' : 'Stage file'))}">${fileActionPending ? loadingRing('file-spinner') : gitIcon(staged ? 'checked' : 'unchecked')}</button>` : ''}
        <button class="file" data-file="${escapeAttr(file.path)}" data-working="${working}" data-status="${escapeAttr(file.status)}" data-staged="${staged}" title="${escapeAttr(file.path)}">${selected && state.diffLoading ? loadingRing('file-spinner') : `<i class="status ${escapeAttr(status)}">${escapeHtml(status)}</i>`}<span class="file-path">${directory ? `<span class="file-directory">${escapeHtml(directory)}</span>` : ''}<span class="file-name">${escapeHtml(fileName)}</span></span></button>
        <button class="file-menu" data-file-menu ${data} title="${zh ? '文件操作' : 'File actions'}" aria-label="${escapeAttr(menuLabel)}">${gitIcon('more')}</button>
      </div>`
    }).join('') || `<div class="empty-list">${zh ? '没有文件变更' : 'No changed files'}</div>`
  }

  function renderDetailContent(zh) {
    if (state.preview?.kind === 'image') return `<div class="image-preview"><div class="image-stage"><img src="data:${escapeAttr(state.preview.mimeType)};base64,${state.preview.data}" alt="${escapeAttr(state.selectedFile.split('/').pop())}"></div><footer><span><b>${escapeHtml(state.selectedFile.split('/').pop())}</b><small>${formatBytes(state.preview.size)}</small></span><button class="${state.revealingPath === state.selectedFile ? 'is-pending' : ''}" data-reveal="${escapeAttr(state.selectedFile)}" ${state.revealingPath === state.selectedFile ? 'disabled aria-busy="true"' : ''}>${state.revealingPath === state.selectedFile ? loadingRing('control-spinner') : gitIcon('reveal')}${zh ? '在文件系统中显示' : 'Show in file browser'}</button></footer></div>`
    if (state.preview?.kind === 'unavailable' || /(?:^|\n)Binary files .* differ(?:\n|$)/.test(state.diff)) {
      const message = state.preview?.message || (zh ? '这是二进制文件，无法显示文本差异。' : 'This binary file has no text diff to display.')
      return `<div class="binary-preview">${gitIcon('image')}<b>${zh ? '无法在此预览' : 'Preview unavailable'}</b><p>${escapeHtml(message)}</p><button class="${state.revealingPath === state.selectedFile ? 'is-pending' : ''}" data-reveal="${escapeAttr(state.selectedFile)}" ${state.revealingPath === state.selectedFile ? 'disabled aria-busy="true"' : ''}>${state.revealingPath === state.selectedFile ? loadingRing('control-spinner') : gitIcon('reveal')}${zh ? '在文件系统中显示' : 'Show in file browser'}</button></div>`
    }
    return renderDiff(state.diff, zh)
  }

  function renderContextMenu(zh) {
    const menu = state.menu
    if (!menu) return ''
    const item = (action, label, danger = false) => `<button data-menu-action="${action}" class="${danger ? 'danger' : ''}" role="menuitem">${label}</button>`
    let items = ''
    if (menu.kind === 'commit') items = [
      item('create-branch-here', zh ? '从这里创建分支…' : 'Create branch here…'),
      item('tag-here', zh ? '添加标签…' : 'Add tag…'),
      '<hr>', item('cherry-pick', zh ? 'Cherry-pick 此提交…' : 'Cherry-pick commit…'),
      item('revert', zh ? '还原此提交…' : 'Revert commit…', true),
      item('reset-to-commit', zh ? '将当前分支重置到此提交…' : 'Reset current branch to this commit…', true),
      '<hr>', item('copy-sha', zh ? '复制完整 SHA' : 'Copy full SHA'),
    ].join('')
    else if (menu.kind === 'ref') items = [
      ...(menu.ref.startsWith('refs/heads/') ? [item('checkout-ref', zh ? '切换到此分支' : 'Checkout branch')] : []),
      item('merge-ref', zh ? '合并到当前分支…' : 'Merge into current branch…'),
      item('copy-ref', zh ? '复制引用名称' : 'Copy ref name'),
    ].join('')
    else if (menu.kind === 'file') items = [
      ...(menu.working ? [menu.staged ? item('unstage-file', zh ? '取消暂存' : 'Unstage file') : item('stage-file', zh ? '暂存文件' : 'Stage file')] : []),
      ...(menu.working ? [item('reset-file', zh ? '丢弃文件改动…' : 'Discard file changes…', true), '<hr>'] : []),
      item('show-in-files', zh ? '在文件系统中显示' : 'Show in file browser'),
      item('copy-path', zh ? '复制相对路径' : 'Copy relative path'),
    ].join('')
    return `<button class="menu-scrim" data-menu-close aria-label="${zh ? '关闭菜单' : 'Close menu'}"></button><div class="context-menu" role="menu" style="visibility:hidden">${items}</div>`
  }

  function renderDialog(zh) {
    const dialog = state.dialog
    if (!dialog) return ''
    const input = dialog.options.length
      ? `<select data-dialog-value>${dialog.options.map(option => `<option value="${escapeAttr(option.value)}" ${option.value === dialog.value ? 'selected' : ''}>${escapeHtml(option.label)}</option>`).join('')}</select>`
      : dialog.label ? `<input data-dialog-value value="${escapeAttr(dialog.value)}" placeholder="${escapeAttr(dialog.label)}" autocomplete="off">` : ''
    return `<div class="dialog-backdrop"><section class="git-dialog" role="dialog" aria-modal="true" aria-labelledby="git-dialog-title"><h3 id="git-dialog-title">${escapeHtml(dialog.title)}</h3>${dialog.description ? `<p>${escapeHtml(dialog.description)}</p>` : ''}${dialog.label ? `<label><span>${escapeHtml(dialog.label)}</span>${input}</label>` : ''}<footer><button type="button" data-dialog-close>${zh ? '取消' : 'Cancel'}</button><button class="primary ${dialog.danger ? 'danger' : ''}" type="button" data-dialog-submit ${dialog.label && !dialog.value ? 'disabled' : ''}>${escapeHtml(dialog.submitLabel || (zh ? '继续' : 'Continue'))}</button></footer></section></div>`
  }

  function renderDiff(text, zh) {
    if (!text) return `<div class="diff-empty">${zh ? '选择文件查看差异' : 'Select a file to inspect its diff'}</div>`
    const lines = text.split('\n')
    if (!lines.some(line => /^@@ /.test(line))) return `<div class="diff-empty">${escapeHtml(text)}</div>`
    let oldLine = 0, newLine = 0, inHunk = false
    return lines.map(line => {
      let kind = 'meta', number = '', display = line
      if (line.startsWith('diff --git ')) { inHunk = false; return '' }
      const hunk = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/)
      if (hunk) {
        oldLine = Number(hunk[1]); newLine = Number(hunk[3]); inHunk = true; return ''
      }
      if (!inHunk || line === '\\ No newline at end of file') return ''
      else if (line.startsWith('+')) { kind = 'add'; number = String(newLine++) }
      else if (line.startsWith('-')) { kind = 'del'; number = String(oldLine++) }
      else { kind = ''; number = `${oldLine++}:${newLine++}` }
      return `<div class="diff-line ${kind}"><i>${number}</i><code>${escapeHtml(display || ' ')}</code></div>`
    }).join('')
  }

  function bind() {
    const zh = state.context.language === 'zh'
    root.querySelector('.search input')?.addEventListener('input', event => { state.query = event.target.value; render(['commits']) })
    root.querySelector('[data-action="toggle-refs"]')?.addEventListener('click', () => { state.refsCollapsed = !state.refsCollapsed; render() })
    root.querySelector('[data-action="refresh"]')?.addEventListener('click', () => void refreshFromControl())
    root.querySelector('[data-action="more"]')?.addEventListener('click', () => void loadMore())
    root.querySelectorAll('[data-command]').forEach(button => button.addEventListener('click', () => handleToolbar(button.dataset.command, zh)))
    root.querySelectorAll('[data-remote-toggle]').forEach(button => button.addEventListener('click', () => {
      const name = button.dataset.remoteToggle
      if (state.expandedRemotes.has(name)) state.expandedRemotes.delete(name)
      else state.expandedRemotes.add(name)
      render()
    }))
    root.querySelectorAll('[data-ref]').forEach(button => button.addEventListener('click', () => button.dataset.ref === 'WORKTREE' ? void loadWorking() : void loadRef(button.dataset.ref)))
    root.querySelector('[data-worktree]')?.addEventListener('click', () => void loadWorking())
    root.querySelectorAll('[data-commit]').forEach(button => button.addEventListener('click', () => void loadCommit(button.dataset.commit)))
    bindFiles(root)
    bindReveal(root.querySelector('.diff'))
    root.querySelectorAll('[data-commit]').forEach(button => button.addEventListener('contextmenu', event => openMenu(event, { kind: 'commit', oid: button.dataset.commit })))
    root.querySelectorAll('[data-ref]').forEach(button => button.dataset.ref !== 'WORKTREE' && button.addEventListener('contextmenu', event => openMenu(event, { kind: 'ref', ref: button.dataset.ref })))
    root.querySelector('[data-menu-close]')?.addEventListener('click', () => { state.menu = null; render() })
    root.querySelectorAll('[data-menu-action]').forEach(button => button.addEventListener('click', () => handleMenu(button.dataset.menuAction, zh)))
    root.querySelector('[data-dialog-close]')?.addEventListener('click', () => { state.dialog = null; render() })
    const dialogValue = root.querySelector('[data-dialog-value]')
    dialogValue?.addEventListener('input', event => { state.dialog.value = event.target.value; const submit = root.querySelector('[data-dialog-submit]'); if (submit) submit.disabled = !event.target.value.trim() })
    dialogValue?.addEventListener('keydown', event => { if (event.key === 'Enter' && !event.isComposing) { event.preventDefault(); submitDialog() } })
    root.querySelector('[data-dialog-submit]')?.addEventListener('click', event => { event.preventDefault(); submitDialog() })
    if (state.dialog) requestAnimationFrame(() => root.querySelector('[data-dialog-value]')?.focus())
    root.querySelector('[data-notice-close]')?.addEventListener('click', dismissNotice)
  }

  function bindFiles(scope) {
    scope.querySelectorAll('[data-file]').forEach(button => {
      button.addEventListener('click', () => void loadFile(button.dataset.file, button.dataset.working === 'true', button.dataset.status))
      button.addEventListener('contextmenu', event => openMenu(event, { kind: 'file', path: button.dataset.file, working: button.dataset.working === 'true', staged: button.dataset.staged === 'true' }))
    })
    scope.querySelectorAll('[data-stage-file]').forEach(button => button.addEventListener('click', event => {
      event.preventDefault(); event.stopPropagation()
      void executeGit(button.dataset.staged === 'true' ? 'unstage' : 'stage', { paths: [button.dataset.path] })
    }))
    scope.querySelectorAll('[data-file-menu]').forEach(button => button.addEventListener('click', event => openMenu(event, { kind: 'file', path: button.dataset.path, working: button.dataset.working === 'true', staged: button.dataset.staged === 'true' })))
  }

  function bindReveal(scope) {
    scope?.querySelectorAll('[data-reveal]').forEach(button => button.addEventListener('click', event => {
      event.preventDefault(); event.stopPropagation(); void revealPath(button.dataset.reveal)
    }))
  }

  async function revealPath(path) {
    if (state.revealingPath) return
    state.revealingPath = path; render()
    try {
      const result = await request('workspace.reveal', { path })
      state.revealingPath = ''
      showNotice(result?.exact === false ? (state.context.language === 'zh' ? '文件不存在，已打开所在目录。' : 'The file is unavailable; opened its containing folder.') : (state.context.language === 'zh' ? '已在文件系统中显示' : 'Shown in file browser'))
    } catch (error) { state.revealingPath = ''; showNotice(friendlyError(error), 'error') }
  }

  function openMenu(event, value) {
    event.preventDefault(); event.stopPropagation()
    state.dialog = null
    const target = event.currentTarget?.getBoundingClientRect?.()
    const fromButton = event.type === 'click'
    const keyboard = !event.clientX && !event.clientY
    state.menu = {
      ...value,
      x: keyboard ? target?.left || 6 : event.clientX,
      y: keyboard ? target?.bottom || 6 : event.clientY,
      fromButton,
      anchor: target ? { left: target.left, right: target.right, top: target.top, bottom: target.bottom } : null,
    }
    render()
  }

  function positionContextMenu() {
    const element = root.querySelector('.context-menu'), menu = state.menu
    if (!element || !menu) return
    const margin = 6, gap = 4, bounds = element.getBoundingClientRect()
    const viewportWidth = document.documentElement.clientWidth, viewportHeight = document.documentElement.clientHeight
    let x = menu.x + 2, y = menu.y + 2
    if (menu.fromButton && menu.anchor) {
      x = menu.anchor.right + gap
      y = menu.anchor.top
      if (x + bounds.width > viewportWidth - margin) x = menu.anchor.left - bounds.width - gap
    } else if (x + bounds.width > viewportWidth - margin) x = menu.x - bounds.width - 2
    if (y + bounds.height > viewportHeight - margin) y = menu.fromButton && menu.anchor ? menu.anchor.bottom - bounds.height : menu.y - bounds.height - 2
    element.style.left = `${Math.max(margin, Math.min(x, viewportWidth - bounds.width - margin))}px`
    element.style.top = `${Math.max(margin, Math.min(y, viewportHeight - bounds.height - margin))}px`
    element.style.visibility = 'visible'
    element.querySelector('button')?.focus({ preventScroll: true })
  }

  function handleMenu(action, zh) {
    const menu = state.menu
    if (!menu) return
    if (action === 'copy-sha' || action === 'copy-ref' || action === 'copy-path') {
      const value = action === 'copy-sha' ? menu.oid : action === 'copy-ref' ? menu.ref : menu.path
      state.menu = null
      void copyText(value).then(() => showNotice(zh ? '已复制' : 'Copied'), error => showNotice(friendlyError(error), 'error'))
      return
    }
    if (action === 'stage-file' || action === 'unstage-file') return void executeGit(action === 'stage-file' ? 'stage' : 'unstage', { paths: [menu.path] })
    if (action === 'reset-file') return openDialog('reset-file', {
      title: zh ? '丢弃此文件的全部改动？' : 'Discard all changes to this file?',
      description: zh ? `${menu.path} 将恢复到 HEAD；如果它是未跟踪文件，则会被删除。此操作无法撤销。` : `${menu.path} will be restored to HEAD. If it is untracked, it will be deleted. This cannot be undone.`,
      paths: [menu.path], danger: true, submitLabel: zh ? '丢弃改动' : 'Discard changes',
    })
    if (action === 'show-in-files') { state.menu = null; return void revealPath(menu.path) }
    if (action === 'checkout-ref') return void executeGit('checkout', { ref: menu.ref })
    if (action === 'merge-ref') return openDialog('merge', { title: zh ? '合并到当前分支' : 'Merge into current branch', value: menu.ref, ref: menu.ref, description: zh ? `合并 ${shortRef(menu.ref)}。` : `Merge ${shortRef(menu.ref)}.` })
    if (action === 'create-branch-here') return openDialog('create-branch', { title: zh ? '从此提交创建分支' : 'Create branch from commit', label: zh ? '分支名称' : 'Branch name', ref: menu.oid })
    if (action === 'tag-here') return openDialog('tag', { title: zh ? '为此提交添加标签' : 'Tag this commit', label: zh ? '标签名称' : 'Tag name', ref: menu.oid })
    if (action === 'reset-to-commit') return openDialog('reset', {
      title: zh ? '将当前分支重置到此提交？' : 'Reset current branch to this commit?',
      label: zh ? '重置模式' : 'Reset mode', value: 'mixed', ref: menu.oid, danger: true, submitLabel: zh ? '重置分支' : 'Reset branch',
      description: zh ? `目标提交：${menu.oid.slice(0, 12)}。硬重置会永久丢弃此提交之后的文件改动。` : `Target commit: ${menu.oid.slice(0, 12)}. A hard reset permanently discards file changes after this commit.`,
      options: zh ? [
        { value: 'mixed', label: 'Mixed（推荐）— 保留文件改动并取消暂存' },
        { value: 'soft', label: 'Soft — 保留文件改动和暂存状态' },
        { value: 'hard', label: 'Hard — 丢弃之后的全部文件改动' },
      ] : [
        { value: 'mixed', label: 'Mixed (recommended) — keep changes, unstage them' },
        { value: 'soft', label: 'Soft — keep changes staged' },
        { value: 'hard', label: 'Hard — discard all later file changes' },
      ],
    })
    if (action === 'cherry-pick' || action === 'revert') return openDialog(action, { title: action === 'revert' ? (zh ? '还原此提交？' : 'Revert this commit?') : (zh ? 'Cherry-pick 此提交？' : 'Cherry-pick this commit?'), ref: menu.oid, danger: action === 'revert', description: menu.oid })
  }

  async function copyText(value) {
    try {
      if (!navigator.clipboard?.writeText) throw Error('Clipboard API unavailable')
      await navigator.clipboard.writeText(value)
      return
    } catch (primaryError) {
      const field = document.createElement('textarea')
      field.value = value
      field.setAttribute('readonly', '')
      field.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0;pointer-events:none'
      document.body.appendChild(field)
      field.focus(); field.select()
      let copied = false
      try { copied = document.execCommand('copy') } finally { field.remove() }
      if (!copied) throw primaryError
    }
  }

  function graphLayout(commits) {
    let lanes = []
    return commits.map(commit => {
      let before = [...lanes], lane = before.indexOf(commit.oid), startsHere = lane < 0
      if (startsHere) { lane = before.length; before.push(commit.oid) }
      const after = before.filter(oid => oid !== commit.oid)
      commit.parents.slice().reverse().forEach(parent => { if (!after.includes(parent)) after.splice(lane, 0, parent) })
      const row = { lane, before, after, parents: commit.parents, startsHere }
      lanes = after.slice(0, 6)
      return row
    })
  }

  function renderGraph(row) {
    if (!row) return '<svg class="graph"></svg>'
    const colors = ['#4c93e8','#c87bdd','#54b983','#df9a55','#dc7078','#70b8c2']
    const x = lane => 7 + lane * 8
    const paths = []
    row.before.forEach((oid, index) => {
      if (index === row.lane) { if (!row.startsHere) paths.push(`<path d="M${x(index)} 0 L${x(index)} 16" stroke="${colors[index % colors.length]}"/>`) }
      else { const next = row.after.indexOf(oid); if (next >= 0) paths.push(`<path d="M${x(index)} 0 C${x(index)} 16 ${x(next)} 16 ${x(next)} 32" stroke="${colors[index % colors.length]}"/>`) }
    })
    row.parents.forEach(parent => { const next = row.after.indexOf(parent); if (next >= 0) paths.push(`<path d="M${x(row.lane)} 16 C${x(row.lane)} 24 ${x(next)} 24 ${x(next)} 32" stroke="${colors[next % colors.length]}"/>`) })
    return `<svg class="graph" viewBox="0 0 52 32" aria-hidden="true"><g fill="none" stroke-width="1.5">${paths.join('')}</g><circle cx="${x(row.lane)}" cy="16" r="3" fill="${colors[row.lane % colors.length]}" stroke="var(--bg)" stroke-width="1.5"/></svg>`
  }

  function stateView(message, loading = false, error = false) { root.innerHTML = `<div class="state ${error ? 'error' : ''}"><span>${loading ? '<i class="spinner"></i>' : ''}${escapeHtml(message)}</span></div>` }
  function filteredCommits(commits, query) { const needle = query.trim().toLowerCase(); return needle ? commits.filter(commit => `${commit.subject} ${commit.authorName} ${commit.authorEmail} ${commit.oid} ${commit.refs.join(' ')}`.toLowerCase().includes(needle)) : commits }
  function overviewFingerprint(overview) {
    if (!overview) return ''
    return JSON.stringify([
      overview.repository?.files?.map(file => [file.path, file.index, file.worktree, file.untracked, file.conflicted]),
      overview.refs?.map(ref => [ref.fullName, ref.current]),
      overview.remotes?.map(remote => [remote.name, remote.fetchUrl]),
      overview.commits?.map(commit => [commit.oid, commit.refs]),
      overview.hasMore,
    ])
  }
  function historyFingerprint(overview) {
    if (!overview) return ''
    return JSON.stringify([
      overview.refs?.map(ref => [ref.fullName, ref.current]),
      overview.remotes?.map(remote => [remote.name, remote.fetchUrl]),
      overview.commits?.map(commit => [commit.oid, commit.refs]),
      overview.hasMore,
    ])
  }
  function workingFiles(overview) { return (overview?.repository.files || []).map(file => ({ path: file.path, status: file.untracked ? '?' : file.conflicted ? 'U' : file.index !== '.' ? file.index : file.worktree, staged: file.staged, unstaged: file.unstaged, untracked: file.untracked })) }
  function previewableImage(path) { return /\.(?:png|jpe?g|gif|webp|bmp|ico|avif)$/i.test(path) }
  function formatBytes(value) { const bytes = Number(value) || 0; if (bytes < 1024) return `${bytes} B`; if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`; return `${(bytes / 1024 / 1024).toFixed(1)} MB` }
  function friendlyError(error) {
    const message = error?.message || String(error)
    if (/Unsupported plugin view method|authorization is missing or expired/.test(message)) return state.context?.language === 'zh' ? '插件宿主仍是旧版本，请重启 Shun 完成 Git Workbench 更新。' : 'The plugin host is still on an older version. Restart Shun to finish updating Git Workbench.'
    return message
  }
  function shortRef(ref) { return ref.replace(/^refs\/(?:heads|tags|remotes)\//, '') }
  function cleanDecoration(value) { return value.replace(/^HEAD -> /, '').replace(/^tag: /, '').replace(/^refs\/(?:heads|tags|remotes)\//, '') }
  function decorationKind(value) { return /^tag: /.test(value) ? 'tag' : /^(?:HEAD -> |refs\/heads\/)/.test(value) ? 'branch' : /^(?:refs\/remotes\/|[^/]+\/)/.test(value) ? 'remote' : 'branch' }
  function relativeDate(value, zh) { const time = Date.parse(value); if (!time) return ''; const seconds = Math.max(0, (Date.now() - time) / 1000); if (seconds < 60) return zh ? '刚刚' : 'now'; if (seconds < 3600) return `${Math.floor(seconds / 60)}m`; if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`; if (seconds < 86400 * 30) return `${Math.floor(seconds / 86400)}d`; return new Date(time).toLocaleDateString(zh ? 'zh-CN' : 'en-US', { month: 'short', day: 'numeric', year: new Date(time).getFullYear() === new Date().getFullYear() ? undefined : 'numeric' }) }
  function fullDate(value, zh) { const time = Date.parse(value); return time ? new Intl.DateTimeFormat(zh ? 'zh-CN' : 'en-US', { year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', timeZoneName: 'short' }).format(time) : '' }
  function escapeHtml(value) { return String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]) }
  const escapeAttr = escapeHtml

  parent.postMessage({ source: 'shun-plugin', channel, type: 'ready' }, '*')
})()
