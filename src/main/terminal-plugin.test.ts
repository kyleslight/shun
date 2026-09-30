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
  const [panel, styles, app, main, surface, feed] = await Promise.all([
    readFile(new URL('../renderer/src/terminal-panel.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../renderer/src/terminal-panel.css', import.meta.url), 'utf8'),
    readFile(new URL('../renderer/src/app.tsx', import.meta.url), 'utf8'),
    readFile(new URL('index.ts', import.meta.url), 'utf8'),
    readFile(new URL('../renderer/src/terminal-surface.ts', import.meta.url), 'utf8'),
    readFile(new URL('../renderer/src/style.css', import.meta.url), 'utf8'),
  ])
  assert.match(panel, /const scrollbackLines = 10_000/)
  assert.doesNotMatch(panel, /RotateCcw|Restart terminal|重新启动终端/)
  assert.match(panel, /<small title=\{view\.boundWorkspace\}>\{view\.boundWorkspace\}<\/small>/)
  assert.match(panel, /is-maximized/)
  // A shell is a surface, not a window onto what it covers: drawn translucent it
  // ghosted the conversation behind it, which is a shell nobody can read. The
  // sheet is solid, and the one shadow says what it sits on.
  assert.match(styles, /\.terminal-panel\{[^}]*background:var\(--code-bg\)[^}]*box-shadow:0 -22px 44px/)
  assert.doesNotMatch(styles, /backdrop-filter/)
  assert.match(styles, /\.terminal-canvas \.xterm-viewport\{background-color:transparent!important/)
  // And it takes the room it occupies from the feed, the way the composer does:
  // an open terminal that buried the end of the conversation under itself is the
  // conversation losing the part somebody was reading.
  assert.match(panel, /useTerminalHeight\(height, maximized\)/)
  assert.match(surface, /root\.style\.setProperty\('--terminal-height', maximized \? '0px' : `\$\{Math\.ceil\(height\)\}px`\)/)
  assert.match(feed, /\.feed\{overflow:auto;padding:35px max\(28px,calc\(\(100% - 820px\)\/2\)\) calc\(var\(--dock-height,180px\) \+ var\(--terminal-height,0px\)\)/)
  // Where a terminal exists is a workspace, and the entry follows that rule on
  // both sides rather than offering a shell it cannot open.
  assert.match(app, /const terminalWorkspace = showRemote \? \(remote\.open \? remoteWorkspace : ""\) : \(task\?\.workspace \|\| ""\)/)
  assert.match(app, /\{terminalAvailable && <button\n\s+class=\{\`terminal-trigger \$\{remote\.terminal \? "active" : ""\}\`\}/)
  assert.match(app, /\{terminalAvailable && <button\n\s+class=\{\`terminal-trigger \$\{terminalView\?\.boundTaskId === currentId \? "active" : ""\}\`\}/)
  assert.match(app, /if \(!showRemote \|\| !remote\.terminal \|\| terminalAvailable\) return;\n\s+remote\.setTerminal\(false\)/)
  assert.match(app, /\{terminal && !!open && !!view\?\.workspace && <RemoteTerminalPanel/)
  assert.match(app, /<span class="header-utility-pair">\n\s+\{terminalAvailable && <button[\s\S]{0,1200}background-trigger[\s\S]{0,700}<\/span>/)
  assert.match(styles, /\.header-utility-pair\{display:flex;align-items:center;gap:2px\}/)
  assert.match(app, /<TerminalPanel[\s\S]*close=\{closeTerminalView\}/)
  assert.match(main, /plugins:view-close[\s\S]*terminalSessions\.closeAccess/)
})
