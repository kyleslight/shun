import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const mainSource = () => readFile(new URL('index.ts', import.meta.url), 'utf8')
const hostSource = () => readFile(new URL('plugin-view-host.ts', import.meta.url), 'utf8')
const preloadSource = () => readFile(new URL('../preload/index.ts', import.meta.url), 'utf8')

/** The dispatcher itself, so an assertion about it cannot be satisfied by a neighbour. */
function capabilityBody(source: string) {
  const lines = source.split('\n')
  const start = lines.findIndex(line => line.startsWith('async function invokePluginViewCapability('))
  assert.notEqual(start, -1, 'invokePluginViewCapability is missing.')
  const end = lines.findIndex((line, index) => index > start && line === '}')
  assert.notEqual(end, -1, 'invokePluginViewCapability has no end.')
  return lines.slice(start, end).join('\n')
}

/**
 * A plugin view is rendered on a surface, and which surface decides what "show
 * this to the person" means. The dispatcher is the half that is the same
 * everywhere, so it must not be able to name the window, the clipboard, the
 * shell, or a WebContents at all: a single `shell.openExternal` put back here
 * is a method that silently keeps working on the machine that ran the plugin
 * and does nothing on a controller, which is the failure this boundary exists
 * to make impossible rather than to remember.
 */
test('the view dispatcher names a surface, never a window or a renderer', async () => {
  const source = await mainSource(), body = capabilityBody(source)
  const signature = body.split('\n')[0]
  assert.match(signature, /readOnlyTest = false, host\?: PluginViewHost\)/)
  assert.doesNotMatch(signature, /WebContents|sender/)
  for (const forbidden of [/\bdialog\./, /\bclipboard\./, /\bshell\./, /\bwin!/, /\bsender\b/, /\bWebContents\b/]) {
    assert.doesNotMatch(body, forbidden, `The dispatcher still reaches for ${forbidden}.`)
  }
})

/** What the surface owns, the surface answers: nothing else may open a file for a view. */
test('the surface is the only place a view is shown something', async () => {
  const host = await hostSource()
  assert.match(host, /export type PluginViewHost = \{[\s\S]*viewing\(\): boolean[\s\S]*onClose\(listener: \(\) => void\): \(\) => void[\s\S]*emit\(event: PluginViewHostEvent\): void/)
  assert.match(host, /export function electronPluginViewHost\(/)
  assert.match(host, /copyText: text => \{ clipboard\.writeText\(text\) \}/)
  assert.match(host, /openExternal: async url => \{ await shell\.openExternal\(url\) \}/)
  // The members a surface may legitimately lack are optional, so "this surface
  // cannot ask" is expressible instead of being a crash waiting on a null window.
  for (const optional of ['choosePath?', 'openWith?', 'attachBrowserGuest?']) assert.match(host, new RegExp(optional))
})

/**
 * Every one of these used to be a call that assumed the rendering window was
 * present, which on a controller is the one thing that is not. Refusing by name
 * is what lets a surface without the capability say so instead of failing as if
 * the machine were broken.
 */
test('a call the surface cannot serve is refused by name', async () => {
  const source = await mainSource()
  for (const refusal of [
    /This surface cannot choose a folder to export into\./,
    /Browser Preview host is unavailable\./,
    /Terminal host is unavailable\./,
    /This invocation has no surface to copy into\./,
    /This invocation has no surface to reveal on\./,
    /This invocation has no surface to open a file on\./,
    /This invocation has no surface to open a site on\./,
    /This surface cannot open a file with a chosen application\./,
  ]) assert.match(source, refusal)
})

/**
 * One host per surface, because the close listener that takes a window's
 * terminals with it belongs to the window. Building a host per call would stack
 * that listener once per open, which is the shape the renderer WeakSet was
 * already there to avoid.
 */
test('a surface holds one host across every call made through it', async () => {
  const source = await mainSource()
  assert.match(source, /const pluginViewHosts = new WeakMap<WebContents, PluginViewHost>\(\)/)
  assert.match(source, /function pluginViewHost\(contents: WebContents\) \{[\s\S]*const existing = pluginViewHosts\.get\(contents\)[\s\S]*if \(existing\) return existing/)
  assert.match(source, /host\.onClose\(\(\) => terminalSessions\.dispose\(\)\)/)
  assert.doesNotMatch(source, /terminalRenderers/)
})

/**
 * A plugin's state belongs to the plugin, not to the window that wrote it: the
 * same plugin in the same workspace must agree everywhere it is shown, and
 * nothing else may be told. Broadcasting to every window cannot express that on
 * a surface that is not a window, which is what a controller is.
 */
test('plugin state is delivered to the views that care and to no one else', async () => {
  const source = await mainSource()
  assert.match(source, /const pluginViewSurfaces = new Map<string, \{ pluginId: string; workspace: string; host: PluginViewHost; stopClose: \(\) => void \}>\(\)/)
  assert.match(source, /function emitPluginWorkspaceState\(pluginId: string, workspace: string, key: string, value: unknown\) \{[\s\S]*for \(const view of pluginViewSurfaces\.values\(\)\) \{[\s\S]*if \(view\.pluginId !== pluginId \|\| view\.workspace !== workspace\) continue[\s\S]*view\.host\.emit\(\{ type: 'state', pluginId, workspace, key, value \}\)/)
  assert.doesNotMatch(source, /BrowserWindow\.getAllWindows\(\)[^\n]*plugin:workspace-changed/)
})

/** An open view is a surface's responsibility, so it is released both ways. */
test('a view is registered with its surface on open and released on close', async () => {
  const source = await mainSource()
  assert.match(source, /ipcMain\.handle\('plugins:view-open', \(event,[\s\S]*pluginViewSurfaces\.set\(contribution\.accessToken, record\)[\s\S]*record\.stopClose = record\.host\.onClose\(\(\) => pluginViewSurfaces\.delete\(contribution\.accessToken\)\)/)
  assert.match(source, /ipcMain\.handle\('plugins:view-close', \(_, accessToken: string\) => \{[\s\S]*pluginViewSurfaces\.get\(token\)\?\.stopClose\(\)[\s\S]*pluginViewSurfaces\.delete\(token\)/)
})

/** The state a surface is handed has to be the event its own UI is listening for. */
test('a state event is sent on the channel the view bridge listens on', async () => {
  const [host, preload] = await Promise.all([hostSource(), preloadSource()])
  assert.match(host, /if \(event\.type === 'state'\) \{ contents\.send\('plugin:workspace-changed', \{ type: 'state', pluginId: event\.pluginId, workspace: event\.workspace, key: event\.key, value: event\.value \}\); return \}/)
  assert.match(preload, /onPluginWorkspace: fn => \{[^\n]*ipcRenderer\.on\('plugin:workspace-changed', listener\)/)
})
