import assert from 'node:assert/strict'
import test from 'node:test'
import { isShellTool, productToolOutputForDisplay, productToolPresentation, shellCommand } from '../renderer/src/tool-presentation.ts'

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
  assert.deepEqual(productToolPresentation({ name: 'browser_debug', input: '{"url":"http://localhost:5174/"}', state: 'done' }), {
    title: 'Inspected local page', detail: 'localhost/', kind: 'browser',
  })
  assert.deepEqual(productToolPresentation({ name: 'browser_open', input: '{"url":"https://example.com/account"}', state: 'done' }), {
    title: 'Opened Chrome tab', detail: 'example.com/account', kind: 'browser',
  })
  assert.deepEqual(productToolPresentation({ name: 'browser_act', input: '{"action":"click","ref":"91"}', state: 'done' }), {
    title: 'Interacted with Chrome tab', detail: 'click · ref 91', kind: 'browser',
  })
  assert.deepEqual(productToolPresentation({ name: 'browser_download', input: '{"ref":"92"}', state: 'done' }), {
    title: 'Downloaded from Chrome', detail: 'link ref 92', kind: 'browser',
  })
  assert.deepEqual(productToolPresentation({ name: 'skill_install', input: '{"source":"lanyasheng/trading-quant/trading-quant"}', state: 'done' }), {
    title: 'Installed Skill', detail: 'lanyasheng/trading-quant/trading-quant', kind: 'skill',
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
  assert.match(css, /\.attachment-preview-dialog\.image-preview>header\{border-bottom-color:#ffffff0d;background:#0b0c0e\}/)
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
  assert.match(css, /:root\[data-theme="light"\] \.attachment-thumb:not\(\.has-image\)\{background:#eceef0/)
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
