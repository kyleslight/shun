import { execFile } from 'node:child_process'
import { accessSync, constants } from 'node:fs'
import { readdir, readFile, realpath, stat } from 'node:fs/promises'
import { basename, delimiter, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { PluginConnectionState } from '../shared.ts'

type GodotResult = { stdout: string; stderr: string }
export type GodotCommandRunner = (args: string[], options?: { cwd?: string; timeoutMs?: number; signal?: AbortSignal }) => Promise<GodotResult>

const MAX_OUTPUT = 24_000
const MAX_PROJECT_FILE_BYTES = 2 * 1024 * 1024
const MAX_SCANNED_FILES = 4_000
const MAX_LISTED_FILES = 80
const IGNORED_DIRECTORIES = new Set(['.git', '.godot', '.import', 'node_modules', 'dist', 'build'])

const defaultRunner: GodotCommandRunner = (args, options = {}) => new Promise((resolvePromise, reject) => {
  execFile(resolveGodotExecutable(), args, {
    cwd: options.cwd,
    timeout: options.timeoutMs || 60_000,
    signal: options.signal,
    maxBuffer: 2 * 1024 * 1024,
    windowsHide: true,
    encoding: 'utf8',
  }, (error, stdout, stderr) => error
    ? reject(Object.assign(error, { stdout, stderr }))
    : resolvePromise({ stdout, stderr }))
})

export function resolveGodotExecutable(
  platform = process.platform,
  pathValue = process.env.PATH || '',
  isExecutable: (path: string) => boolean = executableFile,
) {
  const names = platform === 'win32' ? ['godot4.exe', 'godot.exe'] : ['godot4', 'godot']
  const absolute = platform === 'darwin'
    ? ['/opt/homebrew/bin/godot', '/usr/local/bin/godot', '/Applications/Godot.app/Contents/MacOS/Godot']
    : []
  for (const candidate of absolute) if (isExecutable(candidate)) return candidate
  const pathDelimiter = platform === 'win32' ? ';' : delimiter
  for (const directory of pathValue.split(pathDelimiter).filter(Boolean)) {
    for (const name of names) {
      const candidate = join(directory, name)
      if (isExecutable(candidate)) return candidate
    }
  }
  return names[0]
}

function executableFile(path: string) {
  try { accessSync(path, constants.X_OK); return true } catch { return false }
}

export class GodotService {
  private readonly run: GodotCommandRunner
  private readonly executable: string

  constructor(run: GodotCommandRunner = defaultRunner, executable = resolveGodotExecutable()) {
    this.run = run
    this.executable = executable
  }

  async state(): Promise<PluginConnectionState> {
    try {
      const { stdout, stderr } = await this.run(['--version'], { timeoutMs: 10_000 })
      const version = cleanOutput(stdout || stderr).split(/\s+/)[0] || 'installed'
      return { connected: true, status: 'connected', account: `Godot ${version}`, message: `Godot ${version} is available locally.` }
    } catch (error) {
      return missingGodot(error)
        ? { connected: false, status: 'unavailable', message: 'Godot 4 is not installed or is not available on PATH.' }
        : { connected: false, status: 'error', message: godotError(error) }
    }
  }

  async inspect(cwd: string, projectPath?: unknown) {
    const workspace = await realpath(resolve(cwd))
    const projects = projectPath
      ? [await resolveProject(workspace, projectPath)]
      : await discoverProjects(workspace)
    if (!projects.length) throw Error('No project.godot file was found in the task workspace.')
    const state = await this.state()
    const inspected = await Promise.all(projects.slice(0, 20).map(project => inspectProject(workspace, project)))
    return {
      engine: {
        available: state.connected,
        version: state.account?.replace(/^Godot\s+/, '') || undefined,
        executable: this.executable,
      },
      projects: inspected,
      selection_required: !projectPath && inspected.length > 1,
      truncated: projects.length > inspected.length,
    }
  }

  async checkScript(cwd: string, scriptPathValue: unknown, projectPath?: unknown, signal?: AbortSignal) {
    const workspace = await realpath(resolve(cwd)), project = await resolveSingleProject(workspace, projectPath)
    const scriptPath = await realpath(resolve(project, required(scriptPathValue, 'script_path')))
    assertInside(project, scriptPath, 'Script path escapes the selected Godot project.')
    if (extname(scriptPath).toLowerCase() !== '.gd') throw Error('Godot script checks require a .gd file.')
    try {
      const output = await this.run(['--headless', '--no-header', '--path', project, '--script', scriptPath, '--check-only'], {
        cwd: project, timeoutMs: 45_000, signal,
      })
      return {
        ok: true,
        project: displayPath(workspace, project),
        script: displayPath(project, scriptPath),
        stdout: bounded(cleanOutput(output.stdout)),
        stderr: bounded(cleanOutput(output.stderr)),
      }
    } catch (error) {
      throw Error(`Godot script check failed for ${displayPath(project, scriptPath)}.\n${godotError(error)}`)
    }
  }

  async importProject(cwd: string, projectPath?: unknown, signal?: AbortSignal) {
    const workspace = await realpath(resolve(cwd)), project = await resolveSingleProject(workspace, projectPath)
    try {
      const output = await this.run(['--headless', '--no-header', '--path', project, '--recovery-mode', '--import'], {
        cwd: project, timeoutMs: 5 * 60_000, signal,
      })
      return {
        ok: true,
        project: displayPath(workspace, project),
        stdout: bounded(cleanOutput(output.stdout)),
        stderr: bounded(cleanOutput(output.stderr)),
        note: 'Godot refreshed imported resources and may have updated the project .godot cache.',
      }
    } catch (error) {
      throw Error(`Godot project import failed for ${displayPath(workspace, project)}.\n${godotError(error)}`)
    }
  }
}

async function discoverProjects(workspace: string) {
  const direct = join(workspace, 'project.godot')
  if (await fileExists(direct)) return [workspace]
  const projects: string[] = []
  async function walk(directory: string, depth: number) {
    if (projects.length >= 21 || depth > 4) return
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => [])
    if (entries.some(entry => entry.isFile() && entry.name === 'project.godot')) {
      projects.push(directory)
      return
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || IGNORED_DIRECTORIES.has(entry.name) || entry.name.startsWith('.')) continue
      await walk(join(directory, entry.name), depth + 1)
      if (projects.length >= 21) return
    }
  }
  await walk(workspace, 0)
  return projects.sort()
}

async function resolveSingleProject(workspace: string, projectPath?: unknown) {
  if (projectPath) return resolveProject(workspace, projectPath)
  const projects = await discoverProjects(workspace)
  if (!projects.length) throw Error('No project.godot file was found in the task workspace.')
  if (projects.length > 1) throw Error(`Multiple Godot projects were found. Pass project_path explicitly: ${projects.slice(0, 10).map(path => displayPath(workspace, path)).join(', ')}`)
  return projects[0]
}

async function resolveProject(workspace: string, pathValue: unknown) {
  const requested = required(pathValue, 'project_path')
  let target = await realpath(resolve(workspace, requested))
  let metadata = await stat(target)
  if (metadata.isFile()) {
    if (basename(target) !== 'project.godot') throw Error('project_path must name a Godot project directory or its project.godot file.')
    target = dirname(target)
    metadata = await stat(target)
  }
  if (!metadata.isDirectory()) throw Error('project_path must name a directory.')
  assertInside(workspace, target, 'Godot project path escapes the task workspace.')
  if (!await fileExists(join(target, 'project.godot'))) throw Error(`No project.godot file exists at ${displayPath(workspace, target)}.`)
  return target
}

async function inspectProject(workspace: string, project: string) {
  const settingsPath = join(project, 'project.godot'), metadata = await stat(settingsPath)
  if (metadata.size > MAX_PROJECT_FILE_BYTES) throw Error(`project.godot exceeds the ${MAX_PROJECT_FILE_BYTES / 1024 / 1024} MB inspection limit.`)
  const content = await readFile(settingsPath, 'utf8'), settings = parseGodotConfig(content)
  const inventory = await scanProjectFiles(project)
  return {
    path: displayPath(workspace, project),
    name: stringSetting(settings, 'application/config/name') || basename(project),
    version: stringSetting(settings, 'application/config/version') || undefined,
    config_version: numberSetting(settings, 'config_version'),
    features: arraySetting(settings, 'application/config/features'),
    main_scene: stringSetting(settings, 'application/run/main_scene') || undefined,
    renderer: stringSetting(settings, 'rendering/renderer/rendering_method') || undefined,
    files: inventory,
    has_export_presets: await fileExists(join(project, 'export_presets.cfg')),
  }
}

async function scanProjectFiles(project: string) {
  const lists = { scenes: [] as string[], scripts: [] as string[], shaders: [] as string[], extensions: [] as string[], addons: [] as string[] }
  const counts = { scenes: 0, scripts: 0, shaders: 0, extensions: 0, addons: 0, total: 0 }
  let truncated = false
  async function walk(directory: string, depth: number) {
    if (truncated || depth > 16) return
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (counts.total >= MAX_SCANNED_FILES) { truncated = true; return }
      if (entry.isSymbolicLink()) continue
      const path = join(directory, entry.name)
      if (entry.isDirectory()) {
        if (!IGNORED_DIRECTORIES.has(entry.name)) await walk(path, depth + 1)
        if (truncated) return
        continue
      }
      if (!entry.isFile()) continue
      counts.total++
      const name = displayPath(project, path), extension = extname(entry.name).toLowerCase()
      if (name.startsWith('addons/')) {
        counts.addons++
        if (lists.addons.length < MAX_LISTED_FILES) lists.addons.push(name)
      }
      const category = extension === '.tscn' || extension === '.scn' ? 'scenes'
        : extension === '.gd' || extension === '.cs' ? 'scripts'
          : extension === '.gdshader' || extension === '.shader' ? 'shaders'
            : extension === '.gdextension' ? 'extensions'
              : undefined
      if (!category) continue
      counts[category]++
      if (lists[category].length < MAX_LISTED_FILES) lists[category].push(name)
    }
  }
  await walk(project, 0)
  return { counts, ...lists, truncated }
}

function parseGodotConfig(content: string) {
  const values = new Map<string, string>()
  let section = ''
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim()
    const heading = line.match(/^\[([^\]]+)\]$/)
    if (heading) { section = heading[1]; continue }
    const assignment = line.match(/^([^=]+?)\s*=\s*(.*)$/)
    if (!assignment || line.startsWith(';')) continue
    const key = assignment[1].trim(), full = section ? `${section}/${key}` : key
    values.set(full, assignment[2].trim())
  }
  return values
}

function stringSetting(settings: Map<string, string>, key: string) {
  const value = settings.get(key)
  if (!value) return ''
  if (value.startsWith('"') && value.endsWith('"')) {
    try { return String(JSON.parse(value)) } catch {}
  }
  return value
}

function numberSetting(settings: Map<string, string>, key: string) {
  const value = Number(settings.get(key))
  return Number.isFinite(value) ? value : undefined
}

function arraySetting(settings: Map<string, string>, key: string) {
  return [...(settings.get(key) || '').matchAll(/"((?:\\.|[^"\\])*)"/g)].map(match => {
    try { return String(JSON.parse(`"${match[1]}"`)) } catch { return match[1] }
  })
}

function assertInside(root: string, target: string, message: string) {
  const offset = relative(root, target)
  if (offset === '..' || offset.startsWith(`..${sep}`) || isAbsolute(offset)) throw Error(message)
}

function displayPath(root: string, target: string) {
  const offset = relative(root, target)
  return (offset && offset !== '..' && !offset.startsWith(`..${sep}`) && !isAbsolute(offset) ? offset : target).split(sep).join('/') || '.'
}

async function fileExists(path: string) {
  try { return (await stat(path)).isFile() } catch { return false }
}

function required(value: unknown, label: string) {
  const text = String(value || '').trim()
  if (!text || text.length > 4_096 || /[\u0000-\u001f\u007f]/.test(text)) throw Error(`A valid ${label} is required.`)
  return text
}

function cleanOutput(value: string) { return String(value || '').replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '').trim() }
function bounded(value: string) { return value.length <= MAX_OUTPUT ? value : `${value.slice(0, MAX_OUTPUT - 50)}\n[truncated by Godot tool boundary]` }
function missingGodot(error: unknown) { return (error as NodeJS.ErrnoException)?.code === 'ENOENT' }
function godotError(error: unknown) {
  const value = error as { stdout?: string; stderr?: string; message?: string }
  return bounded(cleanOutput([value.stderr, value.stdout, value.message].filter(Boolean).join('\n')) || 'Godot command failed.')
}
