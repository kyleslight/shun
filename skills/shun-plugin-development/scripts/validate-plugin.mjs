#!/usr/bin/env node
import { lstat, readFile, readdir } from 'node:fs/promises'
import { resolve, sep } from 'node:path'

if (!process.argv[2]) fail('Usage: node validate-plugin.mjs <plugin-directory>')
const root = resolve(process.argv[2])
const manifest = await json(`${root}/manifest.json`)
const id = String(manifest.id || '')
if (manifest.schemaVersion !== 1) fail('schemaVersion must be 1')
if (!/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(id) || id.length > 80) fail('id must use lowercase dot or hyphen notation')
for (const key of ['name', 'description', 'version', 'publisher']) if (!String(manifest[key] || '').trim()) fail(`${key} is required`)
if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(String(manifest.version))) fail('version must use semantic versioning')
const permissions = new Set((manifest.permissions || []).map(item => item?.id))
if (permissions.size !== (manifest.permissions || []).length) fail('permission ids must be unique')
const supported = new Set(['workspace.git.read', 'workspace.git.write', 'workspace.read', 'workspace.reveal', 'conversation.context', 'conversation.ui'])
for (const item of manifest.permissions || []) {
  if (!supported.has(item?.id)) fail(`unsupported permission: ${item?.id || '(missing)'}`)
  if (!String(item?.reason || '').trim()) fail(`permission ${item.id} requires a reason`)
}
if ((manifest.contributes?.conversationActions || []).length && !permissions.has('conversation.ui')) fail('conversationActions require conversation.ui')
const viewIds = new Set()
for (const view of manifest.contributes?.views || []) {
  if (!/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(String(view.id || ''))) fail('view id is invalid')
  if (viewIds.has(view.id)) fail(`duplicate view id: ${view.id}`)
  viewIds.add(view.id)
  if (!['workspace.right', 'workspace.main'].includes(view.location)) fail(`unsupported view location: ${view.location}`)
  const parts = String(view.entry || '').replace(/\\/g, '/').split('/')
  if (parts.some(part => !part || part === '.' || part === '..')) fail('view entry must be package-relative')
  const entry = resolve(root, ...parts)
  if (entry !== root && !entry.startsWith(`${root}${sep}`)) fail('view entry escapes package')
  const html = await readFile(entry, 'utf8').catch(() => fail(`missing view entry: ${view.entry}`))
  if (!/Content-Security-Policy/i.test(html) || !/default-src\s+'none'/i.test(html)) fail(`${view.entry} needs a default-src 'none' CSP`)
  if (/<script(?![^>]*\bsrc=)[^>]*>/i.test(html)) fail(`${view.entry} cannot contain inline scripts`)
}
const actionIds = new Set()
for (const action of manifest.contributes?.conversationActions || []) {
  if (!/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(String(action.id || ''))) fail('conversation action id is invalid')
  if (actionIds.has(action.id)) fail(`duplicate conversation action id: ${action.id}`)
  actionIds.add(action.id)
  if (!['composer', 'message'].includes(action.placement)) fail(`unsupported conversation action placement: ${action.placement}`)
  if (!String(action.title || '').trim() || !String(action.command || '').trim()) fail(`conversation action ${action.id} needs title and command`)
}
for (const skill of manifest.contributes?.skills || []) {
  const parts = String(skill?.path || '').replace(/\\/g, '/').split('/')
  if (parts.some(part => !part || part === '.' || part === '..')) fail('Skill path must be package-relative')
  const directory = resolve(root, ...parts)
  if (directory !== root && !directory.startsWith(`${root}${sep}`)) fail('Skill path escapes package')
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => fail(`missing Skill directory: ${skill.path}`))
  if (!entries.some(entry => entry.isDirectory())) fail(`Skill directory has no Skill packages: ${skill.path}`)
}

let files = 0, bytes = 0
async function walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name)
    const info = await lstat(path)
    if (info.isSymbolicLink()) fail(`symbolic links are not allowed: ${path.slice(root.length + 1)}`)
    if (info.isDirectory()) await walk(path)
    else { files++; bytes += info.size }
  }
}
await walk(root)
if (files > 400) fail(`package has ${files} files; maximum is 400`)
if (bytes > 25 * 1024 * 1024) fail(`package is ${(bytes / 1024 / 1024).toFixed(1)} MB; maximum is 25 MB`)
console.log(`OK ${id} ${manifest.version} · ${files} files · ${bytes} bytes`)

async function json(path) { try { return JSON.parse(await readFile(path, 'utf8')) } catch (error) { fail(`invalid manifest: ${error.message}`) } }
function fail(message) { console.error(`ERROR ${message}`); process.exit(1) }
