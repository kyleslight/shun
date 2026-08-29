import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { validatePluginPackage } from './plugin-packages.ts'

const pluginRoot = new URL('../../resources/plugins/file-manager/', import.meta.url)

test('built-in file manager declares only bounded workspace capabilities', async () => {
  const manifest = validatePluginPackage(JSON.parse(await readFile(new URL('manifest.json', pluginRoot), 'utf8')), 'builtin')
  assert.equal(manifest.id, 'file-manager')
  assert.deepEqual((manifest.permissions || []).map(permission => permission.id), ['workspace.read', 'workspace.reveal'])
  assert.equal(manifest.runtime?.workspace, 'required')
  assert.equal(manifest.contributes?.views?.[0].rail, 'workspace')
  assert.equal(manifest.contributes?.views?.[0].entry, 'ui/index.html')
})

test('file manager keeps tree rendering virtualized and previews bounded and local', async () => {
  const [html, app, css, icon, main] = await Promise.all([
    readFile(new URL('ui/index.html', pluginRoot), 'utf8'),
    readFile(new URL('ui/app.js', pluginRoot), 'utf8'),
    readFile(new URL('ui/styles.css', pluginRoot), 'utf8'),
    readFile(new URL('assets/icon.svg', pluginRoot), 'utf8'),
    readFile(new URL('index.ts', import.meta.url), 'utf8'),
  ])
  assert.match(html, /default-src 'none'/)
  assert.match(html, /style-src 'self' 'nonce-c2h1bi1maWxlLXRyZWU='/)
  assert.match(html, /id="runtime-layout" nonce="c2h1bi1maWxlLXRyZWU="/)
  assert.doesNotMatch(html, /https?:\/\//)
  assert.match(app, /workspace\.list[\s\S]*recursive: false/)
  assert.match(app, /workspace\.search/)
  assert.match(app, /workspace\.pdfPage/)
  assert.match(app, /ROW_HEIGHT = 28/)
  assert.match(app, /MEDIA_LIMIT = 64 \* 1024 \* 1024/)
  assert.match(app, /URL\.revokeObjectURL/)
  assert.match(app, /Open in Word/)
  assert.match(app, /layout\.textContent = rules/)
  assert.match(app, /data-index=/)
  assert.match(app, /data-action="open-with"/)
  assert.match(app, /data-action="reveal"[\s\S]*icons\.folder/)
  assert.match(app, /naturalWidth[\s\S]*naturalHeight/)
  assert.match(app, /data-action="pdf-prev"[\s\S]*data-action="pdf-next"/)
  assert.match(app, /data-action="toggle-tree"/)
  assert.match(app, /message\.event === 'file\.open'/)
  assert.match(app, /openRequestedFile\(message\.payload\)/)
  assert.match(app, /payload\?\.collapseTree[\s\S]*state\.treeCollapsed = true/)
  assert.match(app, /path\.split\('\/'\)\.some\(part => !part \|\| part === '\.' \|\| part === '\.\.'\)/)
  assert.match(app, /state\.expanded\.add\(next\)[\s\S]*await loadDirectory\(next\)[\s\S]*await selectFile\(entry\)/)
  assert.match(app, /data-action="copy-path"/)
  assert.match(app, /workspace\.copyPath/)
  assert.match(app, /name\.startsWith\('\.'\)/)
  assert.match(app, /kind\.mode === 'text' \|\| kind\.mode === 'unsupported'/)
  assert.match(app, /kind\.mode === 'text' \? kind\.language : t\('Plain text', '纯文本'\)/)
  assert.doesNotMatch(app, /'hover-bg': 'hover'|'sidebar-item-selected': 'selected'/)
  assert.match(app, /'sidebar-bg': 'sidebar-source'/)
  assert.doesNotMatch(app, /style="/)
  assert.match(css, /grid-template-rows: 40px minmax\(0, 1fr\)/)
  assert.match(css, /\.tree-pane[^{]*\{[^}]*grid-template-rows: 40px minmax\(0, 1fr\)/)
  assert.match(css, /\.tree-space[^{]*\{[^}]*position: relative/)
  assert.match(css, /\.tree-row[^{]*\{[^}]*position: absolute/)
  assert.match(css, /--hover: color-mix\(in srgb, var\(--text\) 4%, transparent\)/)
  assert.match(css, /--selected: color-mix\(in srgb, var\(--accent\) 11%, transparent\)/)
  assert.match(css, /data-theme="light"[^}]*--sidebar: color-mix\(in srgb, var\(--sidebar-source\) 82%, var\(--panel\)\)/)
  assert.match(css, /\.copy-path svg[^{]*\{[^}]*transform: translateY\(1px\)/)
  assert.match(css, /::selection[^{]*\{[^}]*background: color-mix\(in srgb, var\(--accent\) 34%, transparent\)[^}]*color: var\(--text\)/)
  assert.match(css, /search-cancel-button[^{]*\{[^}]*display: none/)
  assert.match(css, /\.workspace\.tree-collapsed[^{]*\{[^}]*grid-template-columns: 34px/)
  assert.match(css, /\.tree-row\.active[^{]*\{[^}]*box-shadow: inset 2px 0 0/)
  assert.match(css, /button:not\(:disabled\) \{ cursor: pointer; \}/)
  assert.match(icon, /stroke="#96999E"[\s\S]*stroke="#D0D1D3"/)
  assert.doesNotMatch(icon, /linearGradient|#7CA6E8/)
  assert.match(main, /application === 'choose'/)
  assert.match(main, /method === 'workspace\.copyPath'[\s\S]*clipboard\.writeText\(target\.target\)/)
  assert.match(main, /'open-with': 'choose'[\s\S]*system: 'choose'/)
  assert.match(main, /\/usr\/bin\/open[\s\S]*-a/)
  assert.match(main, /shell32\.dll,OpenAs_RunDLL/)
})
