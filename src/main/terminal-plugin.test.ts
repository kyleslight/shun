import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { validatePluginPackage } from './plugin-packages.ts'

const pluginRoot = new URL('../../resources/plugins/terminal/', import.meta.url)

test('built-in Terminal is a user-only bottom workspace utility with explicit process permission', async () => {
  const [manifestSource, icon] = await Promise.all([
    readFile(new URL('manifest.json', pluginRoot), 'utf8'),
    readFile(new URL('assets/icon.svg', pluginRoot), 'utf8'),
  ])
  const manifest = validatePluginPackage(JSON.parse(manifestSource), 'builtin')
  assert.equal(manifest.source, 'builtin')
  assert.deepEqual(manifest.permissions, [{ id: 'workspace.process', reason: 'Start an interactive shell in the selected workspace.' }])
  assert.deepEqual(manifest.contributes?.views, [{
    id: 'terminal.main', title: 'Terminal', location: 'workspace.bottom', entry: 'ui/index.html', rail: 'transient', launch: ['user'],
  }])
  assert.match(icon, /<rect[\s\S]*stroke="#96999E"[\s\S]*stroke="#D0D1D3"/)
  assert.doesNotMatch(icon, /#6FD69A|#82ADFA/)
})

test('Terminal UI is bounded, resizable, maximizable, and closes through view cleanup', async () => {
  const [panel, styles, app, main] = await Promise.all([
    readFile(new URL('../renderer/src/terminal-panel.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../renderer/src/terminal-panel.css', import.meta.url), 'utf8'),
    readFile(new URL('../renderer/src/app.tsx', import.meta.url), 'utf8'),
    readFile(new URL('index.ts', import.meta.url), 'utf8'),
  ])
  assert.match(panel, /const scrollbackLines = 10_000/)
  assert.doesNotMatch(panel, /RotateCcw|Restart terminal|重新启动终端/)
  assert.match(panel, /<small title=\{view\.boundWorkspace\}>\{view\.boundWorkspace\}<\/small>/)
  assert.match(panel, /is-maximized/)
  assert.match(styles, /backdrop-filter:blur\(14px\)/)
  assert.match(styles, /\.terminal-canvas \.xterm-viewport\{background-color:transparent!important/)
  assert.doesNotMatch(styles, /box-shadow:/)
  assert.match(app, /terminal-trigger[\s\S]*<SquareTerminal/)
  assert.match(app, /<span class="header-utility-pair">[\s\S]*terminal-trigger[\s\S]*background-trigger[\s\S]*<\/span>/)
  assert.match(styles, /\.header-utility-pair\{display:flex;align-items:center;gap:2px\}/)
  assert.match(app, /<TerminalPanel[\s\S]*close=\{closeTerminalView\}/)
  assert.match(main, /plugins:view-close[\s\S]*terminalSessions\.closeAccess/)
})
