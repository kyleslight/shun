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
const supported = new Set(['workspace.git.read', 'workspace.git.write', 'workspace.read', 'workspace.reveal', 'workspace.process', 'conversation.context', 'conversation.ui'])
for (const item of manifest.permissions || []) {
  if (!supported.has(item?.id)) fail(`unsupported permission: ${item?.id || '(missing)'}`)
  if (!String(item?.reason || '').trim()) fail(`permission ${item.id} requires a reason`)
}
const workspace = manifest.runtime?.workspace ?? ((manifest.contributes?.views || []).length || (manifest.contributes?.workers || []).length || [...permissions].some(permission => String(permission).startsWith('workspace.')) ? 'required' : 'none')
if (!['none', 'optional', 'required'].includes(workspace)) fail(`unsupported runtime.workspace: ${workspace}`)
if (workspace === 'none' && [...permissions].some(permission => String(permission).startsWith('workspace.'))) fail('a workspace-independent plugin cannot request workspace permissions')
const runtimeAssetIds = new Set(), runtimeAssetPaths = new Set()
for (const asset of manifest.runtime?.assets || []) {
  const assetId = String(asset?.id || '')
  if (!/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(assetId) || runtimeAssetIds.has(assetId)) fail(`invalid or duplicate runtime asset id: ${assetId || '(missing)'}`)
  runtimeAssetIds.add(assetId)
  const path = packageParts(asset.path, `runtime asset ${assetId} path`).join('/')
  if (runtimeAssetPaths.has(path)) fail(`duplicate runtime asset path: ${path}`)
  runtimeAssetPaths.add(path)
  if (!Number.isInteger(asset.bytes) || asset.bytes < 1 || asset.bytes > 256 * 1024 * 1024) fail(`runtime asset ${assetId} bytes must be an integer from 1 through 268435456`)
  if (asset.url !== undefined) {
    let url
    try { url = new URL(String(asset.url)) } catch { fail(`runtime asset ${assetId} URL is invalid`) }
    if (url.protocol !== 'https:' || url.username || url.password || url.hash) fail(`runtime asset ${assetId} URL must be credential-free HTTPS without a fragment`)
  }
}
const runtimeExecutableIds = new Set()
let runtimeExecutableBudget = 0
for (const executable of manifest.runtime?.executables || []) {
  const executableId = String(executable?.id || '')
  if (!/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(executableId) || runtimeExecutableIds.has(executableId)) fail(`invalid or duplicate runtime executable id: ${executableId || '(missing)'}`)
  runtimeExecutableIds.add(executableId)
  if (!String(executable?.version || '').trim()) fail(`runtime executable ${executableId} requires a version`)
  const targets = executable?.targets
  if (!Array.isArray(targets) || !targets.length || targets.length > 12) fail(`runtime executable ${executableId} requires 1 through 12 targets`)
  const targetKeys = new Set()
  let maximumTargetBytes = 0
  for (const target of targets) {
    const platform = String(target?.platform || ''), arch = String(target?.arch || ''), archive = String(target?.archive || '')
    if (!['darwin', 'win32', 'linux'].includes(platform)) fail(`runtime executable ${executableId} has unsupported platform ${platform || '(missing)'}`)
    if (!['arm64', 'x64'].includes(arch)) fail(`runtime executable ${executableId} has unsupported architecture ${arch || '(missing)'}`)
    if (!['raw', 'tar.gz', 'zip'].includes(archive)) fail(`runtime executable ${executableId} has unsupported archive ${archive || '(missing)'}`)
    const targetKey = `${platform}-${arch}`
    if (targetKeys.has(targetKey)) fail(`runtime executable ${executableId} has duplicate target ${targetKey}`)
    targetKeys.add(targetKey)
    packageParts(target.entry, `runtime executable ${executableId} entry`)
    if (!Number.isInteger(target.bytes) || target.bytes < 1 || target.bytes > 256 * 1024 * 1024) fail(`runtime executable ${executableId} target bytes must be an integer from 1 through 268435456`)
    maximumTargetBytes = Math.max(maximumTargetBytes, target.bytes)
    let url
    try { url = new URL(String(target.url || '')) } catch { fail(`runtime executable ${executableId} target URL is invalid`) }
    if (url.protocol !== 'https:' || url.username || url.password || url.hash) fail(`runtime executable ${executableId} target URL must be credential-free HTTPS without a fragment`)
  }
  runtimeExecutableBudget += maximumTargetBytes
}
const runtimeAssetBudget = [...(manifest.runtime?.assets || [])].reduce((total, asset) => total + asset.bytes, 0)
if (runtimeAssetBudget + runtimeExecutableBudget > 512 * 1024 * 1024) fail('runtime dependencies exceed the 512 MB current-platform cache budget')
if ((manifest.contributes?.conversationActions || []).length && !permissions.has('conversation.ui')) fail('conversationActions require conversation.ui')
const icon = String(manifest.icon || 'plugin')
if (!['git', 'plugin'].includes(icon)) {
  const parts = packageParts(icon, 'icon')
  if (!/\.svg$/i.test(icon)) fail('custom plugin icon must be a package-relative SVG file')
  const path = resolve(root, ...parts)
  const source = await readFile(path, 'utf8').catch(() => fail(`missing plugin icon: ${icon}`))
  if (Buffer.byteLength(source) > 256 * 1024 || !/<svg(?:\s|>)/i.test(source)) fail('custom plugin icon must be a valid SVG no larger than 256 KB')
}
const viewIds = new Set(), viewLaunches = new Map()
for (const view of manifest.contributes?.views || []) {
  if (!/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(String(view.id || ''))) fail('view id is invalid')
  if (viewIds.has(view.id)) fail(`duplicate view id: ${view.id}`)
  viewIds.add(view.id)
  if (view.location !== 'workspace.right') fail(`unsupported view location: ${view.location}; plugin UI must use workspace.right`)
  if (view.rail !== undefined && view.rail !== 'on-demand') fail('installed plugin views must use rail=on-demand')
  const launch = view.launch ?? ['user', 'assistant']
  if (!Array.isArray(launch) || !launch.length || new Set(launch).size !== launch.length || launch.some(source => !['user', 'assistant', 'tool-result', 'conversation-action'].includes(source))) fail(`view ${view.id} launch must contain unique supported sources`)
  if (view.activation !== undefined && (!view.activation || typeof view.activation !== 'object' || Array.isArray(view.activation))) fail(`view ${view.id} activation must be an object`)
  if (view.activation?.fileChanges !== undefined) {
    const patterns = view.activation.fileChanges
    if (!Array.isArray(patterns) || !patterns.length || patterns.length > 16 || new Set(patterns).size !== patterns.length || patterns.some(pattern => !safeFileChangePattern(pattern))) fail(`view ${view.id} activation.fileChanges must contain 1 through 16 unique safe workspace-relative glob patterns`)
    if (!launch.includes('tool-result')) fail(`view ${view.id} file-change activation requires tool-result launch`)
  }
  viewLaunches.set(view.id, new Set(launch))
  const parts = String(view.entry || '').replace(/\\/g, '/').split('/')
  if (parts.some(part => !part || part === '.' || part === '..')) fail('view entry must be package-relative')
  const entry = resolve(root, ...parts)
  if (entry !== root && !entry.startsWith(`${root}${sep}`)) fail('view entry escapes package')
  const html = await readFile(entry, 'utf8').catch(() => fail(`missing view entry: ${view.entry}`))
  if (!/Content-Security-Policy/i.test(html) || !/default-src\s+'none'/i.test(html)) fail(`${view.entry} needs a default-src 'none' CSP`)
  if (/<script(?![^>]*\bsrc=)[^>]*>/i.test(html)) fail(`${view.entry} cannot contain inline scripts`)
}
const workerIds = new Set()
for (const worker of manifest.contributes?.workers || []) {
  if (!/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(String(worker.id || ''))) fail('worker id is invalid')
  if (workerIds.has(worker.id)) fail(`duplicate worker id: ${worker.id}`)
  workerIds.add(worker.id)
  const parts = packageParts(worker.entry, 'worker entry')
  if (!/\.(?:mjs|js|cjs)$/i.test(String(worker.entry))) fail(`worker ${worker.id} entry must be a JavaScript module`)
  const timeoutMs = worker.timeoutMs === undefined ? 30000 : Number(worker.timeoutMs)
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 120000) fail(`worker ${worker.id} timeoutMs must be an integer from 100 through 120000`)
  const runtime = worker.runtime === undefined ? [] : worker.runtime
  if (!Array.isArray(runtime) || new Set(runtime).size !== runtime.length || runtime.some(executableId => !runtimeExecutableIds.has(executableId))) fail(`worker ${worker.id} runtime must reference unique declared executable ids`)
  const entry = resolve(root, ...parts)
  await lstat(entry).catch(() => fail(`missing worker entry: ${worker.entry}`))
}
if (workerIds.size && !permissions.has('workspace.process')) fail('workers require workspace.process')
const actionIds = new Set()
for (const action of manifest.contributes?.conversationActions || []) {
  if (!/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(String(action.id || ''))) fail('conversation action id is invalid')
  if (actionIds.has(action.id)) fail(`duplicate conversation action id: ${action.id}`)
  actionIds.add(action.id)
  if (!['composer', 'message'].includes(action.placement)) fail(`unsupported conversation action placement: ${action.placement}`)
  const command = String(action.command || '').trim(), viewId = String(action.viewId || '').trim()
  if (!String(action.title || '').trim() || (!command && !viewId)) fail(`conversation action ${action.id} needs a title and command or viewId`)
  if (viewId && !viewIds.has(viewId)) fail(`conversation action ${action.id} references unknown view ${viewId}`)
  if (viewId && !viewLaunches.get(viewId)?.has('conversation-action')) fail(`view ${viewId} must allow conversation-action launch`)
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
function packageParts(value, label) {
  const parts = String(value || '').replace(/\\/g, '/').split('/')
  if (parts.some(part => !part || part === '.' || part === '..')) fail(`${label} must be package-relative`)
  const path = resolve(root, ...parts)
  if (path !== root && !path.startsWith(`${root}${sep}`)) fail(`${label} escapes package`)
  return parts
}
function safeFileChangePattern(value) {
  const pattern = String(value || '').trim().replace(/\\/g, '/')
  return Boolean(pattern) && pattern.length <= 160 && !pattern.startsWith('/') && !/^[A-Za-z]:\//.test(pattern) && !pattern.split('/').some(part => !part || part === '..') && !/[\[\]{}\0]/.test(pattern)
}
function fail(message) { console.error(`ERROR ${message}`); process.exit(1) }
