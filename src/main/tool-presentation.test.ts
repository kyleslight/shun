import assert from 'node:assert/strict'
import test from 'node:test'
import { isShellTool, productToolOutputForDisplay, productToolPresentation, shellCommand } from '../tool-presentation.ts'

test('canonical bash and legacy run tools share one shell presentation path', () => {
  assert.equal(isShellTool('bash'), true)
  assert.equal(isShellTool('run'), true)
  assert.equal(isShellTool('read'), false)
  assert.equal(shellCommand({ name: 'bash', input: '{"command":"lsof -ti :5174 | xargs kill"}' }), 'lsof -ti :5174 | xargs kill')
  assert.equal(shellCommand({ name: 'run', input: '{"command":" pnpm build "}' }), 'pnpm build')
})

test('malformed shell input produces an empty safe detail instead of a dot placeholder', () => {
  assert.equal(shellCommand({ name: 'bash', input: 'not json' }), '')
})

test('Skill read output never exposes its private filesystem location', () => {
  const path = '/Users/private-user/.shun/skills/tradingview/SKILL.md'
  const output = productToolOutputForDisplay({
    name: 'read',
    input: JSON.stringify({ path }),
    state: 'error',
    output: `ENOENT: failed to read ${path}`,
  })
  assert.equal(output, 'ENOENT: failed to read tradingview · instructions')
  assert.doesNotMatch(output, /private-user|\.shun/)
})

test('native plugin tools use canonical product names and structured targets', () => {
  assert.deepEqual(productToolPresentation({ name: 'github_repo_list', input: '{}', state: 'done' }), {
    title: 'Listed GitHub repositories', detail: 'my repositories', kind: 'github',
  })
  assert.deepEqual(productToolPresentation({ name: 'github_repository', input: '{"repo":"openai/codex"}', state: 'error' }), {
    title: 'GitHub repository lookup failed', detail: 'openai/codex', kind: 'github',
  })
  assert.deepEqual(productToolPresentation({ name: 'figma_read_design', input: '{"url":"https://www.figma.com/design/abc/File?node-id=1-2"}', state: 'done' }), {
    title: 'Read Figma design', detail: 'www.figma.com/design/abc/File', kind: 'figma',
  })
  assert.deepEqual(productToolPresentation({ name: 'gmail_message_list', input: '{"query":"is:unread from:alice@example.com"}', state: 'done' }), {
    title: 'Searched Gmail messages', detail: 'is:unread from:alice@example.com', kind: 'gmail',
  })
  assert.deepEqual(productToolPresentation({ name: 'gmail_message_modify', input: '{"message_id":"18abc123","action":"archive"}', state: 'done' }), {
    title: 'Archived Gmail message', detail: '18abc123', kind: 'gmail',
  })
  assert.deepEqual(productToolPresentation({ name: 'gmail_attachment_import', input: '{"message_id":"18abc123","attachment_id":"attach_1","filename":"report.pdf"}', state: 'done' }), {
    title: 'Imported Gmail attachment', detail: 'report.pdf', kind: 'gmail',
  })
  assert.deepEqual(productToolPresentation({ name: 'gmail_message_send', input: '{"to":["alice@example.com"],"subject":"Hello","body":"Hi"}', state: 'done' }), {
    title: 'Sent Gmail message', detail: 'alice@example.com', kind: 'gmail',
  })
  assert.deepEqual(productToolPresentation({ name: 'render_deploy_trigger', input: '{"service_id":"srv-example"}', state: 'done' }), {
    title: 'Triggered Render deployment', detail: 'srv-example', kind: 'render',
  })
  assert.deepEqual(productToolPresentation({ name: 'cloudflare_pages_deployment_retry', input: '{"account_id":"account-id","project_name":"dashboard","deployment_id":"deployment-id"}', state: 'done' }), {
    title: 'Retried Pages deployment', detail: 'dashboard', kind: 'cloudflare',
  })
  assert.deepEqual(productToolPresentation({ name: 'cloudflare_cache_purge', input: '{"zone_id":"zone-id","files":["https://example.com/app.js"]}', state: 'done' }), {
    title: 'Purged Cloudflare cache', detail: 'example.com · 1 URL', kind: 'cloudflare',
  })
  assert.deepEqual(productToolPresentation({ name: 'cloudflare_zone_list', input: '{"account_id":"8ee145a9cddcd295437cecb6fc988abd"}', output: '{"result":[{"account":{"id":"8ee145a9cddcd295437cecb6fc988abd","name":"Personal sites"}}]}', state: 'done' }), {
    title: 'Listed Cloudflare zones', detail: 'Personal sites', kind: 'cloudflare',
  })
  assert.deepEqual(productToolPresentation({ name: 'cloudflare_worker_list', input: '{"account_id":"8ee145a9cddcd295437cecb6fc988abd"}', state: 'done' }), {
    title: 'Listed Cloudflare Workers', detail: 'Cloudflare Workers', kind: 'cloudflare',
  })
  assert.deepEqual(productToolPresentation({ name: 'plugin_tool_search', input: '{"query":"."}', state: 'done' }), {
    title: 'Prepared plugin tools', detail: '', kind: 'skill',
  })
  assert.deepEqual(productToolPresentation({ name: 'schedule_create', input: '{"name":"Daily review","cron":"0 9 * * 1-5","timezone":"Asia/Shanghai"}', state: 'done' }), {
    title: 'Created scheduled task', detail: 'Daily review', kind: 'schedule',
  })
  assert.deepEqual(productToolPresentation({ name: 'schedule_update', input: '{"schedule_id":"schedule_1","status":"paused"}', state: 'error' }), {
    title: 'Scheduled task update failed', detail: 'paused', kind: 'schedule',
  })
  assert.deepEqual(productToolPresentation({ name: 'browser_debug', input: '{"url":"http://localhost:5174/"}', state: 'done' }), {
    title: 'Inspected local page', detail: 'localhost/', kind: 'browser',
  })
  assert.deepEqual(productToolPresentation({ name: 'ios_simulator_snapshot', input: '{"device":"E551ED2E"}', state: 'done' }), {
    title: 'Inspected iOS Simulator', detail: 'E551ED2E', kind: 'ios',
  })
  assert.deepEqual(productToolPresentation({ name: 'ios_simulator_setting', input: '{"action":"appearance","device":"E551ED2E","value":"light"}', state: 'done' }), {
    title: 'Changed iOS Simulator state', detail: 'appearance · light', kind: 'ios',
  })
  assert.deepEqual(productToolPresentation({ name: 'ios_simulator_act', input: '{"action":"tap","device":"E551ED2E","x":0.5,"y":0.5}', state: 'error' }), {
    title: 'iOS Simulator interaction failed', detail: 'tap · E551ED2E', kind: 'ios',
  })
  assert.deepEqual(productToolPresentation({ name: 'godot_project_inspect', input: '{"project_path":"games/quest"}', state: 'done' }), {
    title: 'Inspected Godot project', detail: 'games/quest', kind: 'godot',
  })
  assert.deepEqual(productToolPresentation({ name: 'godot_script_check', input: '{"project_path":"games/quest","script_path":"scripts/player.gd"}', state: 'error' }), {
    title: 'Godot script check failed', detail: 'scripts/player.gd', kind: 'godot',
  })
  assert.deepEqual(productToolPresentation({ name: 'godot_project_import', input: '{}', state: 'done' }), {
    title: 'Refreshed Godot imports', detail: 'task workspace', kind: 'godot',
  })
  assert.deepEqual(productToolPresentation({ name: 'browser_open', input: '{"url":"https://example.com/account"}', state: 'done' }), {
    title: 'Opened Chrome tab', detail: 'example.com/account', kind: 'browser',
  })
  assert.deepEqual(productToolPresentation({
    name: 'browser_claim', input: '{"tab_id":1460935051}',
    output: '{"id":"0531957a-04ad-48c8-b241-ae7d5a2a5669","tabId":1460935051,"title":"Bilibili search results","url":"https://search.bilibili.com/all?keyword=track"}', state: 'done',
  }), {
    title: 'Claimed Chrome tab', detail: 'Bilibili search results · search.bilibili.com', kind: 'browser',
  })
  assert.deepEqual(productToolPresentation({
    name: 'browser_snapshot', input: '{"session_id":"0531957a-04ad-48c8-b241-ae7d5a2a5669"}',
    output: '{"session_id":"0531957a-04ad-48c8-b241-ae7d5a2a5669","tab_id":1460935051,"title":"Bilibili search results","url":"https://search.bilibili.com/all"}', state: 'done',
  }), {
    title: 'Inspected Chrome tab', detail: 'Bilibili search results · search.bilibili.com', kind: 'browser',
  })
  assert.deepEqual(productToolPresentation({ name: 'browser_act', input: '{"session_id":"private-session","action":"click","ref":"91"}', state: 'running' }), {
    title: 'Interacted with Chrome tab', detail: 'Current Chrome tab', kind: 'browser',
  })
  assert.deepEqual(productToolPresentation({ name: 'browser_download', input: '{"session_id":"private-session","ref":"92"}', output: '{"filename":"/Users/me/Downloads/report.pdf"}', state: 'done' }), {
    title: 'Downloaded from Chrome', detail: 'report.pdf', kind: 'browser',
  })
  assert.deepEqual(productToolPresentation({ name: 'skill_install', input: '{"source":"lanyasheng/trading-quant/trading-quant"}', state: 'done' }), {
    title: 'Installed Skill', detail: 'lanyasheng/trading-quant/trading-quant', kind: 'skill',
  })
  assert.deepEqual(productToolPresentation({
    name: 'skill_install', input: '{"source":"community/marketing-skills"}', output: '{"status":"selection_required"}', state: 'done',
  }), {
    title: 'Reviewed Skill source', detail: 'community/marketing-skills', kind: 'skill',
  })
  assert.deepEqual(productToolPresentation({ name: 'skill_create', input: '{"name":"design-review","description":"Review designs.","instructions":"Inspect the design."}', state: 'done' }), {
    title: 'Created Skill', detail: 'design-review', kind: 'skill',
  })
  assert.deepEqual(productToolPresentation({ name: 'skill_update', input: '{"name":"design-review","append_instructions":"Report concrete gaps."}', state: 'done' }), {
    title: 'Updated Skill', detail: 'design-review', kind: 'skill',
  })
  assert.deepEqual(productToolPresentation({ name: 'skill_remove', input: '{"names":["ads","analytics"]}', state: 'done' }), {
    title: 'Removed Skills', detail: 'ads, analytics', kind: 'skill',
  })
  assert.deepEqual(productToolPresentation({ name: 'skill_catalog_search', input: '{"query":"quant trading"}', state: 'done' }), {
    title: 'Searched installable Skills', detail: 'quant trading', kind: 'skill',
  })
  assert.deepEqual(productToolPresentation({ name: 'read', input: '{"path":"/Users/private-user/.shun/skills/tradingview/SKILL.md"}', state: 'done' }), {
    title: 'Read Skill instructions', detail: 'tradingview · instructions', kind: 'skill',
  })
  assert.deepEqual(productToolPresentation({ name: 'read', input: '{"path":"C:\\\\Users\\\\private-user\\\\.shun\\\\skills\\\\yahoo-finance\\\\SKILL.md"}', state: 'done' }), {
    title: 'Read Skill instructions', detail: 'yahoo-finance · instructions', kind: 'skill',
  })
  assert.deepEqual(productToolPresentation({ name: 'read', input: '{"path":"/Users/private-user/.shun/resources/plugin-skills/github/github-pull-requests/SKILL.md"}', state: 'done' }), {
    title: 'Read Skill instructions', detail: 'github-pull-requests · instructions', kind: 'skill',
  })
  assert.deepEqual(productToolPresentation({ name: 'skill_run', input: '{"skill":"tradingview","script":"scripts/fetch_tradingview.py"}', state: 'done' }), {
    title: 'Ran Skill script', detail: 'tradingview · scripts/fetch_tradingview.py', kind: 'skill',
  })
  assert.deepEqual(productToolPresentation({ name: 'skill_run', input: '{"skill":"tradingview","script":"scripts/fetch_tradingview.py","command":"screen"}', state: 'error' }), {
    title: 'Skill script failed', detail: 'tradingview · screen', kind: 'skill',
  })
})

test('Chrome tool presentation never exposes internal tab or session identifiers', () => {
  const output = JSON.stringify({
    id: '0531957a-04ad-48c8-b241-ae7d5a2a5669', session_id: '0531957a-04ad-48c8-b241-ae7d5a2a5669',
    tab_id: 1460935051, taskId: 'task-a', createdByRunId: 'run-a', tabId: 1460935051, windowId: 7,
    title: 'Bilibili search results', url: 'https://search.bilibili.com/all', state: 'attached',
    tabs: [{ id: 1460935051, title: 'Bilibili search results', url: 'https://search.bilibili.com/all' }],
  })
  const displayed = productToolOutputForDisplay({ name: 'browser_snapshot', input: '{"session_id":"private-session"}', state: 'done', output })
  assert.doesNotMatch(displayed, /0531957a|1460935051|task-a|run-a|windowId|session_id|tab_id|tabId/)
  assert.match(displayed, /Bilibili search results/)
  assert.match(displayed, /search\.bilibili\.com/)
})

test('Chrome activity summaries use page language instead of generic code-search language', async () => {
  const app = await import('node:fs/promises').then(fs => fs.readFile(new URL('../renderer/src/app.tsx', import.meta.url), 'utf8'))
  assert.match(app, /browserOnly = tools\.length > 0[\s\S]*正在查看 Chrome 页面[\s\S]*已查看 Chrome 页面/)
  assert.match(app, /product\?\.kind === "browser"[\s\S]*"used Chrome"/)
  assert.match(app, /isRecoveredBrowserConnectionFailure[\s\S]*not connected[\s\S]*later\.state === "done"/)
})

test('local PDF reads retain a canonical product tool identity', async () => {
  const app = await import('node:fs/promises').then(fs => fs.readFile(new URL('../renderer/src/app.tsx', import.meta.url), 'utf8'))
  assert.match(app, /tool\.name === "read_pdf"[\s\S]*FileText/)
  assert.match(app, /tool\.name === "read_pdf"[\s\S]*title: "Read PDF"/)
})

test('direct tool execution has no product permission popup or internal runtime branding', async () => {
  const fs = await import('node:fs/promises')
  const app = await fs.readFile(new URL('../renderer/src/app.tsx', import.meta.url), 'utf8')
  const preload = await fs.readFile(new URL('../preload/index.ts', import.meta.url), 'utf8')
  const shared = await fs.readFile(new URL('../shared.ts', import.meta.url), 'utf8')
  assert.doesNotMatch(app, /Approval needed|Allow once|Ask before changes|修改前询问|permissionMenu/)
  assert.match(app, /Shun does not add per-command permission popups/)
  assert.doesNotMatch(app, /\bPi\b|与 Pi|Like Pi|Pi-compatible/i)
  assert.doesNotMatch(preload, /agent:approve|approve:/)
  assert.doesNotMatch(shared, /permission:|'approval'|'waiting'/)
})

test('attachments expose one content-aware read tool while legacy view events remain renderable', async () => {
  const app = await import('node:fs/promises').then(fs => fs.readFile(new URL('../renderer/src/app.tsx', import.meta.url), 'utf8'))
  const main = await import('node:fs/promises').then(fs => fs.readFile(new URL('index.ts', import.meta.url), 'utf8'))
  assert.match(app, /tool\.name === "attachment_view"[\s\S]*FileImage/)
  assert.match(app, /tool\.name === "attachment_list"[\s\S]*Paperclip/)
  assert.match(app, /tool\.name === "attachment_read"[\s\S]*title: "Read attachment"/)
  assert.match(main, /name: 'attachment_read'[\s\S]*Type\.Literal\('semantic'\)[\s\S]*Type\.Literal\('ocr'\)[\s\S]*Type\.Literal\('visual'\)/)
  assert.match(main, /readAttachmentForModel\(attachments, sessionId, args\.attachment_id/)
  assert.doesNotMatch(main, /name: 'attachment_view'/)
})

test('repeated reads of one attachment are not presented as multiple files', async () => {
  const app = await import('node:fs/promises').then(fs => fs.readFile(new URL('../renderer/src/app.tsx', import.meta.url), 'utf8'))
  assert.match(app, /attachmentNames = new Map\(\[\.\.\.attachments, \.\.\.turns\.flatMap/)
  assert.match(app, /attachmentToolName\(tool, input\.attachment_id \|\| "attachment", attachmentNames\)/)
  assert.match(app, /targets\.length === 1[\s\S]*已读取 \$\{targets\[0\]\} \$\{reads\} 次/)
  assert.match(app, /targets\.length === 1[\s\S]*Read \$\{targets\[0\]\} \$\{reads\} times/)
  assert.doesNotMatch(app, /`已读取 \$\{reads\} 个文件`/)
})

test('the composer imports pasted clipboard images through the attachment data boundary', async () => {
  const app = await import('node:fs/promises').then(fs => fs.readFile(new URL('../renderer/src/app.tsx', import.meta.url), 'utf8'))
  const preload = await import('node:fs/promises').then(fs => fs.readFile(new URL('../preload/index.ts', import.meta.url), 'utf8'))
  assert.match(app, /onPaste=.*importClipboardImages/)
  assert.match(app, /file\.arrayBuffer\(\)/)
  assert.match(preload, /importAttachmentData:.*attachment:import-data/)
})

test('attachment-only messages do not invent a visible instruction bubble', async () => {
  const app = await import('node:fs/promises').then(fs => fs.readFile(new URL('../renderer/src/app.tsx', import.meta.url), 'utf8'))
  assert.match(app, /if \(!prompt && !pendingAttachments\.length\) return/)
  assert.match(app, /runPrompt\(prompt, turns, task, undefined, pendingAttachments, selectedSkill\)/)
  assert.doesNotMatch(app, /Please inspect and process these attachments|请查看并处理这些附件/)
})

test('image tool results are materialized and shown inline in the conversation flow', async () => {
  const app = await import('node:fs/promises').then(fs => fs.readFile(new URL('../renderer/src/app.tsx', import.meta.url), 'utf8'))
  const main = await import('node:fs/promises').then(fs => fs.readFile(new URL('index.ts', import.meta.url), 'utf8'))
  const runtime = await import('node:fs/promises').then(fs => fs.readFile(new URL('agent-runtime.ts', import.meta.url), 'utf8'))
  const css = await import('node:fs/promises').then(fs => fs.readFile(new URL('../renderer/src/attachments.css', import.meta.url), 'utf8'))
  assert.match(runtime, /materializeToolResultImages[\s\S]*resultImages\(event\.result\.content\)/)
  assert.match(main, /materializeToolResultImages:[\s\S]*normalizeImageForModel[\s\S]*attachments\.importBuffers/)
  assert.match(app, /function ToolMedia[\s\S]*tool\.attachments[\s\S]*AttachmentCards[\s\S]*adaptiveImages/)
  assert.match(app, /<ToolMedia tools=\{tools\}/)
  assert.match(css, /\.tool-media[\s\S]*object-fit:contain/)
  assert.match(app, /function adaptiveImageCardStyle[\s\S]*Math\.min\(460, 320 \* ratio\)[\s\S]*aspectRatio/)
  assert.match(app, /preview\.width && preview\.height[\s\S]*onImageDimensions/)
  assert.match(css, /\.tool-media \.attachment-card\.image-card\{[^}]*height:auto;aspect-ratio:16\/9/)
  assert.doesNotMatch(css, /\.tool-media \.attachment-card\.image-card\{[^}]*height:(?:260|210)px/)
})

test('tool evidence and expanded browser or shell output share the response left edge', async () => {
  const attachments = await import('node:fs/promises').then(fs => fs.readFile(new URL('../renderer/src/attachments.css', import.meta.url), 'utf8'))
  const trace = await import('node:fs/promises').then(fs => fs.readFile(new URL('../renderer/src/trace-polish.css', import.meta.url), 'utf8'))
  assert.match(attachments, /\.tool-media\{margin-left:0\}/)
  assert.match(trace, /\.tool-row-body\{margin-left:0\}/)
})

test('action summaries vertically center the icon, title, and command detail', async () => {
  const trace = await import('node:fs/promises').then(fs => fs.readFile(new URL('../renderer/src/trace-polish.css', import.meta.url), 'utf8'))
  assert.match(trace, /\.action-summary \.activity-head\{[^}]*align-items:center/)
  assert.match(trace, /\.action-summary \.activity-head>span\{[^}]*align-items:center/)
  assert.match(trace, /\.action-summary \.activity-head b\{[^}]*height:15px[^}]*align-items:center[^}]*line-height:15px/)
  assert.match(trace, /\.action-summary \.activity-head small\{[^}]*line-height:15px/)
})

test('the slash palette exposes only useful implemented task commands with keyboard selection', async () => {
  const fs = await import('node:fs/promises')
  const app = await fs.readFile(new URL('../renderer/src/app.tsx', import.meta.url), 'utf8')
  const css = await fs.readFile(new URL('../renderer/src/final-refine.css', import.meta.url), 'utf8')
  const catalog = app.slice(app.indexOf('const commands:'), app.indexOf('const markdown'))
  assert.match(catalog, /\/archive[\s\S]*\/review[\s\S]*\/compact[\s\S]*\/model[\s\S]*\/rename/)
  assert.match(catalog, /\/status[\s\S]*\/plugins[\s\S]*\/skills[\s\S]*\/settings/)
  assert.doesNotMatch(catalog, /\/copy|\/export|\/import|\/clear/)
  assert.match(app, /ArrowDown[\s\S]*setSlashIndex[\s\S]*selectSlashCommand/)
  assert.match(app, /initialTab=\{pluginHubTab\}/)
  assert.match(app, /conversation\?: boolean[\s\S]*id: "archive"[\s\S]*conversation: true/)
  assert.match(app, /filter\(\(command\) => !command\.conversation \|\| hasConversation\)/)
  assert.match(css, /\.slash-menu button\.selected[^{]*\{[^}]*composer-popover-selected/)
  assert.match(css, /\.slash-menu button>svg\{[^}]*width:16px/)
})

test('archiving the selected task opens a fresh task instead of selecting another conversation', async () => {
  const fs = await import('node:fs/promises')
  const app = await fs.readFile(new URL('../renderer/src/app.tsx', import.meta.url), 'utf8')
  const archive = app.slice(app.indexOf('function archiveTask'), app.indexOf('function deleteTask'))
  assert.match(archive, /archived && id === currentId/)
  assert.match(archive, /makeTask\(item\.workspace/)
  assert.match(archive, /commitTasks\(\[next, \.\.\.updated\.filter\(hasTaskContent\)\], next\.id\)/)
})

test('enabled Skills appear in the slash palette and apply to only the selected message', async () => {
  const fs = await import('node:fs/promises')
  const app = await fs.readFile(new URL('../renderer/src/app.tsx', import.meta.url), 'utf8')
  const css = await fs.readFile(new URL('../renderer/src/final-refine.css', import.meta.url), 'utf8')
  assert.match(app, /window\.shun\.skills\(\{ \.\.\.settings, workspace:/)
  assert.match(app, /\.filter\(\(skill\) => skill\.installed && skill\.enabled\)/)
  assert.match(app, /class="slash-menu-section"[\s\S]*Skills/)
  assert.match(app, /slashMenu[\s\S]*aria-selected="true"[\s\S]*menu\.scrollTop/)
  assert.match(app, /class="selected-skill-chip"/)
  assert.match(app, /selected-skill-logo \$\{selectedSkill\.icon \|\| "plugin"\}/)
  assert.doesNotMatch(app, /For the next message/)
  assert.match(css, /\.selected-skill-chip\{[^}]*border:1px solid #303030[^}]*background:#1d1d1d[^}]*color:#c8c8c8/)
  assert.doesNotMatch(css, /\.selected-skill-chip\{[^}]*(?:--accent|surface-2|border-1)/)
  assert.match(app, /requestText = skillInvocationName \? `\/skill:\$\{skillInvocationName\}/)
  assert.match(app, /capabilities: skill \? \{ \.\.\.target\.capabilities, skillIds: \[skill\.id\] \}/)
})

test('image delivery is automatic and the opened preview uses a full-window original-image surface', async () => {
  const app = await import('node:fs/promises').then(fs => fs.readFile(new URL('../renderer/src/app.tsx', import.meta.url), 'utf8'))
  const css = await import('node:fs/promises').then(fs => fs.readFile(new URL('../renderer/src/attachments.css', import.meta.url), 'utf8'))
  const main = await import('node:fs/promises').then(fs => fs.readFile(new URL('index.ts', import.meta.url), 'utf8'))
  const preload = await import('node:fs/promises').then(fs => fs.readFile(new URL('../preload/index.ts', import.meta.url), 'utf8'))
  assert.doesNotMatch(app, /Enable Vision|打开 Vision|vision-toggle/)
  assert.match(app, /previewAttachment\(item\.taskId, item\.id, page, "display"\)/)
  assert.match(app, /previewAttachment\(item\.taskId, item\.id, 1, 'model'\)/)
  assert.match(css, /\.attachment-preview-dialog\{[^}]*width:100vw[^}]*height:100vh/)
  assert.match(app, /navigator\.platform\.includes\("Mac"\) \? "mac-titlebar"/)
  assert.match(css, /\.attachment-preview-dialog\.mac-titlebar>header\{padding-left:88px\}/)
  assert.match(css, /\.window-fullscreen \.attachment-preview-dialog\.mac-titlebar>header\{padding-left:14px\}/)
  assert.match(css, /\.attachment-preview-dialog\.image-preview>header\{border-bottom-color:#ffffff0d;background:#0c0c0c\}/)
  assert.match(app, /class="attachment-preview-zoom"/)
  assert.match(app, /Math\.round\(imageViewport\.zoom \* 100\)/)
  assert.match(app, /onWheel=.*zoomImageBy/)
  assert.match(app, /onPointerDown=\{beginImagePan\}/)
  assert.match(app, /onDblClick=\{resetImageViewport\}/)
  assert.match(app, /new ResizeObserver\(fit\)/)
  assert.match(app, /availableWidth = Math\.max\(1, stage\.clientWidth/)
  assert.match(app, /availableHeight = Math\.max\(1, stage\.clientHeight/)
  assert.match(app, /width: imageFit\.width \? `\$\{imageFit\.width\}px`/)
  assert.match(css, /\.attachment-image-stage\{[^}]*width:100%;height:100%[^}]*touch-action:none/)
  assert.match(css, /\.attachment-image-stage img\{[^}]*max-width:none;max-height:none[^}]*object-fit:contain/)
  assert.doesNotMatch(css, /--preview-width|--preview-height/)
  assert.match(css, /\.attachment-card\.image-card\{width:144px;height:112px/)
  assert.match(css, /\.attachment-card\.image-card \.attachment-thumb img\{width:100%;height:100%;padding:0;object-fit:cover;border-radius:0\}/)
  assert.match(css, /background:#202020/)
  assert.match(css, /:root\[data-theme="light"\] \.attachment-thumb:not\(\.has-image\)\{background:#eeeeee/)
  assert.match(main, /label: 'Copy Image'/)
  assert.match(main, /label: 'Save Image As…'/)
  assert.match(preload, /copyAttachmentImage:.*attachment:image-copy/)
  assert.match(preload, /saveAttachmentImage:.*attachment:image-save/)
  assert.match(app, /showAttachmentImageMenu\(item\.taskId, item\.id\)/)
  assert.match(app, /if \(item\.kind !== 'image'\) return/)
  assert.match(app, /item\.kind === 'pdf'\) return <span class="attachment-pdf-icon"/)
  assert.doesNotMatch(app, /item\.kind !== 'image' && item\.kind !== 'pdf'/)
  assert.match(app, /return item\.kind === 'image' \|\| item\.kind === 'text'/)
  assert.match(app, /previewable \? <button[^]*attachment-static/)
})
