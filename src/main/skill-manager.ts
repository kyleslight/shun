import { constants } from 'node:fs'
import { execFile } from 'node:child_process'
import { access, copyFile, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import {
  DefaultPackageManager,
  DefaultResourceLoader,
  ProjectTrustStore,
  SettingsManager,
  loadSkillsFromDir,
  type Skill,
} from '@earendil-works/pi-coding-agent'
import type { Settings, SkillCreateRequest, SkillDocument, SkillState, SkillUpdateRequest } from '../shared.ts'

const MAX_SKILL_FILES = 400
const MAX_SKILL_BYTES = 25 * 1024 * 1024
const MAX_SKILL_MARKDOWN = 512 * 1024
const ignoredEntries = new Set(['.git', 'node_modules', '.DS_Store'])
const execFileAsync = promisify(execFile)

export function skillInstallationId(name: string) {
  return `skill:${name}`
}

export function skillEnabled(settings: Pick<Settings, 'skills'>, name: string) {
  return settings.skills?.find(item => item.id === skillInstallationId(name))?.enabled !== false
}

export function skillCatalogQuery(value: unknown) {
  const interest = String(value || '').replace(/\s+/g, ' ').trim().slice(0, 240)
  return interest
    ? `installable Agent Skills SKILL.md packages for ${interest}`
    : 'installable Agent Skills SKILL.md catalogs and repositories'
}

export type GitHubSkillSource = { cloneUrl: string; repository: string; requestedPath?: string }

export type SkillRuntime = {
  kind: 'python'
  interpreter: string
  scripts: string[]
  dependencies: string[]
  ready: boolean
}

export function parseGitHubSkillSource(value: unknown): GitHubSkillSource | null {
  const source = String(value || '').trim().replace(/\/+$/, '')
  const url = source.match(/^https?:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?(?:\/(?:tree\/[^/]+\/)?(.+))?$/i)
  const shorthand = source.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)(?:\/(.+))?$/)
  const match = url || shorthand
  if (!match) return null
  const owner = match[1]
  const repository = match[2]
  const requestedPath = match[3]?.replace(/^\/+|\/+$/g, '')
  if (requestedPath?.split('/').some(part => !part || part === '.' || part === '..')) throw Error('Invalid Skill path in GitHub source.')
  return {
    cloneUrl: `https://github.com/${owner}/${repository}.git`,
    repository,
    ...(requestedPath ? { requestedPath } : {}),
  }
}

export class SkillManager {
  readonly #agentDir: string

  constructor(agentDir: string) {
    this.#agentDir = resolve(agentDir)
  }

  async list(settings: Pick<Settings, 'skills'>, workspace = ''): Promise<SkillState[]> {
    const cwd = workspace ? resolve(workspace) : this.#agentDir
    const projectTrusted = workspace ? new ProjectTrustStore(this.#agentDir).get(cwd) === true : false
    const manager = SettingsManager.create(cwd, this.#agentDir, { projectTrusted })
    const loader = new DefaultResourceLoader({
      cwd,
      agentDir: this.#agentDir,
      settingsManager: manager,
      noExtensions: true,
      noPromptTemplates: true,
      noThemes: true,
    })
    await loader.reload({ resolveProjectTrust: async () => projectTrusted })
    const loaded = loader.getSkills()
    return loaded.skills.map(skill => this.#state(skill, settings, loaded.diagnostics.filter(item => item.path === skill.filePath).map(item => item.message)))
  }

  async create(request: SkillCreateRequest, settings: Pick<Settings, 'skills'> = {}): Promise<SkillDocument> {
    const name = validName(request.name)
    const description = validDescription(request.description)
    const instructions = String(request.instructions || '').trim()
    if (!instructions) throw Error('Skill instructions are required.')
    const content = skillMarkdown(name, description, instructions, request.disableModelInvocation === true)
    await validateSkillMarkdown(content, name)
    const directory = this.#managedDirectory(name)
    if (await exists(directory)) throw Error(`A local Skill named ${name} already exists.`)
    await mkdir(this.#skillsDir(), { recursive: true })
    await mkdir(directory, { recursive: false })
    await writeFile(join(directory, 'SKILL.md'), content, { encoding: 'utf8', mode: 0o600 })
    return this.read(skillInstallationId(name), settings)
  }

  async importPath(sourceValue: string, settings: Pick<Settings, 'skills'> = {}): Promise<SkillState[]> {
    const source = resolve(String(sourceValue || ''))
    const info = await lstat(source)
    if (info.isSymbolicLink()) throw Error('Skill imports cannot be symbolic links.')
    const root = info.isDirectory() ? source : dirname(source)
    const loaded = loadSkillsFromDir({ dir: root, source: 'import' })
    const selected = info.isDirectory() ? loaded.skills : loaded.skills.filter(skill => resolve(skill.filePath) === source)
    if (!selected.length) throw Error('No valid Agent Skill or SKILL.md file was found.')
    await mkdir(this.#skillsDir(), { recursive: true })
    const names = new Set<string>()
    for (const skill of selected) {
      validName(skill.name)
      if (names.has(skill.name)) throw Error(`The import contains more than one Skill named ${skill.name}.`)
      names.add(skill.name)
      if (await exists(this.#managedDirectory(skill.name))) throw Error(`A local Skill named ${skill.name} already exists.`)
    }
    for (const skill of selected) {
      const destination = this.#managedDirectory(skill.name)
      await mkdir(destination, { recursive: false })
      try {
        if (basename(skill.filePath) === 'SKILL.md') await copySkillTree(skill.baseDir, destination)
        else await copyFile(skill.filePath, join(destination, 'SKILL.md'))
        await validateSkillMarkdown(await readFile(join(destination, 'SKILL.md'), 'utf8'), skill.name)
      } catch (error) {
        await rm(destination, { recursive: true, force: true })
        throw error
      }
    }
    const states = await this.list(settings)
    return states.filter(item => names.has(item.name) && item.origin === 'local')
  }

  async read(idValue: string, settings: Pick<Settings, 'skills'>, workspace = ''): Promise<SkillDocument> {
    const id = String(idValue || '').trim()
    const selector = id.replace(/^skill:/i, '').toLowerCase()
    const skills = await this.list(settings, workspace)
    const skill = skills.find(item => item.id.toLowerCase() === id.toLowerCase() || item.name.toLowerCase() === selector)
    if (!skill?.filePath) throw Error(`Skill not found: ${id}`)
    const content = await readFile(skill.filePath, 'utf8')
    if (content.length > MAX_SKILL_MARKDOWN) throw Error('SKILL.md is too large to edit in Shun.')
    return { skill, content }
  }

  async update(idValue: string, contentValue: string, settings: Pick<Settings, 'skills'>, workspace = ''): Promise<SkillDocument> {
    const current = await this.read(idValue, settings, workspace)
    if (!current.skill.editable || !current.skill.filePath || current.skill.origin !== 'local') throw Error('Only Shun-managed local Skills can be edited.')
    const content = String(contentValue || '')
    if (Buffer.byteLength(content) > MAX_SKILL_MARKDOWN) throw Error('SKILL.md is too large.')
    await validateSkillMarkdown(content, current.skill.name)
    const temp = `${current.skill.filePath}.tmp`
    await writeFile(temp, content, { encoding: 'utf8', mode: 0o600 })
    await rename(temp, current.skill.filePath)
    return this.read(idValue, settings, workspace)
  }

  async updateManaged(request: SkillUpdateRequest, settings: Pick<Settings, 'skills'>, workspace = ''): Promise<SkillDocument> {
    const name = validName(request.name)
    const current = await this.read(name, settings, workspace)
    if (!current.skill.editable || current.skill.origin !== 'local') throw Error('Only Shun-managed local Skills can be edited.')
    const operations = [request.instructions !== undefined, request.appendInstructions !== undefined, request.instructionPatch !== undefined].filter(Boolean).length
    if (operations > 1) throw Error('Choose one instruction update: replace, append, or exact text patch.')
    if (!operations && request.description === undefined && request.disableModelInvocation === undefined) throw Error('Provide at least one Skill change.')

    const parsed = managedSkillMarkdown(current.content)
    const description = request.description === undefined ? current.skill.description : validDescription(request.description)
    const disableModelInvocation = request.disableModelInvocation === undefined ? parsed.disableModelInvocation : request.disableModelInvocation
    let body = parsed.body
    if (request.instructions !== undefined) {
      const instructions = String(request.instructions || '').trim()
      if (!instructions) throw Error('Skill instructions are required.')
      body = skillBody(name, instructions)
    } else if (request.appendInstructions !== undefined) {
      const addition = String(request.appendInstructions || '').trim()
      if (!addition) throw Error('Appended Skill instructions are required.')
      body = `${body.trimEnd()}\n\n${addition}\n`
    } else if (request.instructionPatch !== undefined) {
      const find = String(request.instructionPatch.find || '')
      if (!find) throw Error('The instruction text to replace is required.')
      const matches = body.split(find).length - 1
      if (matches !== 1) throw Error(`Expected one exact instruction match, found ${matches}.`)
      body = body.replace(find, String(request.instructionPatch.replace || ''))
    }

    const content = serializeManagedSkillMarkdown(name, description, disableModelInvocation, parsed.extraFrontmatter, body)
    return this.update(current.skill.id, content, settings, workspace)
  }

  async remove(idValue: string, settings: Pick<Settings, 'skills'>, workspace = '') {
    const current = await this.read(idValue, settings, workspace)
    if (!current.skill.removable || current.skill.origin !== 'local' || !current.skill.filePath) throw Error('Only Shun-managed local Skills can be removed here.')
    const directory = resolve(dirname(current.skill.filePath))
    const root = resolve(this.#skillsDir())
    if (!directory.startsWith(`${root}${sep}`) || directory === root) throw Error('Refusing to remove a Skill outside Shun’s managed directory.')
    await Promise.all([
      rm(directory, { recursive: true, force: true }),
      rm(join(this.#agentDir, 'environments', 'skills', validName(current.skill.name)), { recursive: true, force: true }),
    ])
    return true
  }

  async installPackage(sourceValue: string, settings: Pick<Settings, 'skills'>, workspace = '') {
    const source = validPackageSource(sourceValue)
    const cwd = workspace ? resolve(workspace) : this.#agentDir
    const settingsManager = SettingsManager.create(cwd, this.#agentDir)
    const packages = new DefaultPackageManager({ cwd, agentDir: this.#agentDir, settingsManager })
    await packages.installAndPersist(source)
    await restrictPackageToSkills(packages, settingsManager, source)
    await settingsManager.flush()
    const states = await this.list(settings, workspace)
    const installedPath = packages.getInstalledPath(source, 'user')
    const installed = states.filter(item => item.origin === 'package' && (!installedPath || item.filePath?.startsWith(`${resolve(installedPath)}${sep}`)))
    if (!installed.length) {
      await packages.removeAndPersist(source).catch(() => false)
      await settingsManager.flush()
      throw Error('The package does not expose any Skills, so Shun rolled back the installation.')
    }
    return installed
  }

  async installSource(sourceValue: string, settings: Pick<Settings, 'skills'>, workspace = '') {
    const github = parseGitHubSkillSource(sourceValue)
    if (!github) return this.installPackage(sourceValue, settings, workspace)
    const root = await mkdtemp(join(tmpdir(), 'shun-skill-source-'))
    const repository = join(root, 'repository')
    try {
      await execFileAsync('git', ['clone', '--depth', '1', '--', github.cloneUrl, repository], {
        timeout: 60_000,
        maxBuffer: 1024 * 1024,
      })
      const target = await resolveGitHubSkillTarget(repository, github)
      const installed = await this.importPath(target, settings)
      return await Promise.all(installed.map(async skill => {
        try {
          await this.prepareRuntime(skill.id, settings, workspace)
          return skill
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          return { ...skill, diagnostics: [...(skill.diagnostics || []), `Runtime preparation failed: ${message}`] }
        }
      }))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw Error(`Could not install Skill from GitHub: ${message}`)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }

  async updatePackage(sourceValue: string, settings: Pick<Settings, 'skills'>, workspace = '') {
    const source = validPackageSource(sourceValue)
    const cwd = workspace ? resolve(workspace) : this.#agentDir
    const settingsManager = SettingsManager.create(cwd, this.#agentDir)
    const packages = new DefaultPackageManager({ cwd, agentDir: this.#agentDir, settingsManager })
    await packages.update(source)
    return this.list(settings, workspace)
  }

  async removePackage(sourceValue: string, workspace = '') {
    const source = validPackageSource(sourceValue)
    const cwd = workspace ? resolve(workspace) : this.#agentDir
    const settingsManager = SettingsManager.create(cwd, this.#agentDir)
    const packages = new DefaultPackageManager({ cwd, agentDir: this.#agentDir, settingsManager })
    const changed = await packages.removeAndPersist(source)
    await settingsManager.flush()
    return changed
  }

  async prepareRuntime(idValue: string, settings: Pick<Settings, 'skills'>, workspace = ''): Promise<SkillRuntime | null> {
    const document = await this.read(idValue, settings, workspace)
    if (!document.skill.filePath) return null
    const baseDir = dirname(document.skill.filePath)
    const scripts = await pythonScripts(baseDir)
    if (!scripts.length) return null
    const python = await systemPython()
    const environment = join(this.#agentDir, 'environments', 'skills', validName(document.skill.name))
    const interpreter = process.platform === 'win32' ? join(environment, 'Scripts', 'python.exe') : join(environment, 'bin', 'python')
    if (!await exists(interpreter)) {
      await mkdir(dirname(environment), { recursive: true })
      await execFileAsync(python.command, [...python.args, '-m', 'venv', environment], { timeout: 60_000, maxBuffer: 1024 * 1024 })
    }
    const requirements = join(baseDir, 'requirements.txt')
    const requirementContent = await readOptional(requirements)
    const dependencies = requirementContent
      ? requirementContent.split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith('#'))
      : await inferredPythonDependencies(scripts.map(script => join(baseDir, script)), python)
    const marker = join(environment, '.shun-dependencies.json')
    const fingerprint = JSON.stringify({ requirementContent, dependencies })
    if (await readOptional(marker) !== fingerprint) {
      if (requirementContent) {
        await execFileAsync(interpreter, ['-m', 'pip', 'install', '--disable-pip-version-check', '--no-input', '-r', requirements], { timeout: 180_000, maxBuffer: 4 * 1024 * 1024 })
      } else if (dependencies.length) {
        await execFileAsync(interpreter, ['-m', 'pip', 'install', '--disable-pip-version-check', '--no-input', ...dependencies], { timeout: 180_000, maxBuffer: 4 * 1024 * 1024 })
      }
      await writeFile(marker, fingerprint, 'utf8')
    }
    return { kind: 'python', interpreter, scripts, dependencies, ready: true }
  }

  async runPython(idValue: string, scriptValue: string, argsValue: unknown[], settings: Pick<Settings, 'skills'>, workspace = '') {
    const document = await this.read(idValue, settings, workspace)
    if (!document.skill.filePath) throw Error('This Skill has no runnable local files.')
    const baseDir = dirname(document.skill.filePath)
    const runtime = await this.prepareRuntime(document.skill.id, settings, workspace)
    if (!runtime) throw Error('This Skill does not contain Python scripts.')
    const script = resolve(baseDir, String(scriptValue || ''))
    if (!script.startsWith(`${resolve(baseDir)}${sep}`) || !runtime.scripts.some(item => resolve(baseDir, item) === script)) throw Error('Choose a Python script referenced by this Skill’s instructions.')
    const args = argsValue.map(value => String(value))
    if (args.length > 64 || args.some(value => value.length > 2_048 || /\u0000/.test(value))) throw Error('Skill script arguments exceed the safe boundary.')
    try {
      const output = await execFileAsync(runtime.interpreter, [script, ...args], {
        cwd: baseDir,
        timeout: 120_000,
        maxBuffer: 4 * 1024 * 1024,
        env: { ...process.env, PYTHONUNBUFFERED: '1' },
      })
      return { skill: document.skill.id, script: relative(baseDir, script), stdout: output.stdout, stderr: output.stderr, runtime }
    } catch (error) {
      const failure = error as Error & { stdout?: string; stderr?: string }
      throw Error([failure.message, failure.stdout, failure.stderr].filter(Boolean).join('\n').slice(-12_000))
    }
  }

  #skillsDir() {
    return join(this.#agentDir, 'skills')
  }

  #managedDirectory(name: string) {
    return join(this.#skillsDir(), validName(name))
  }

  #state(skill: Skill, settings: Pick<Settings, 'skills'>, diagnostics: string[]): SkillState {
    const filePath = resolve(skill.filePath)
    const managedRoot = resolve(this.#skillsDir())
    const managed = filePath.startsWith(`${managedRoot}${sep}`)
    const origin = managed ? 'local' : skill.sourceInfo.origin === 'package' ? 'package' : skill.sourceInfo.scope === 'project' ? 'project' : 'external'
    return {
      id: skillInstallationId(skill.name),
      name: skill.name,
      description: skill.description,
      installed: true,
      enabled: skillEnabled(settings, skill.name),
      origin,
      filePath,
      ...(origin === 'package' ? { packageSource: skill.sourceInfo.source } : {}),
      editable: origin === 'local',
      removable: origin === 'local' || origin === 'package',
      ...(diagnostics.length ? { diagnostics } : {}),
    }
  }
}

export async function resolveGitHubSkillTarget(repositoryRoot: string, source: GitHubSkillSource) {
  const root = resolve(repositoryRoot)
  if (source.requestedPath) {
    const requested = resolve(root, source.requestedPath)
    if (!requested.startsWith(`${root}${sep}`)) throw Error('Skill path escapes the repository.')
    if (await exists(join(requested, 'SKILL.md'))) return requested

    const conventional = resolve(root, 'skills', source.requestedPath)
    if (conventional.startsWith(`${root}${sep}`) && await exists(join(conventional, 'SKILL.md'))) return conventional

    const loaded = loadSkillsFromDir({ dir: root, source: 'remote' })
    const selector = source.requestedPath.split('/').filter(Boolean).at(-1)
    const matches = loaded.skills.filter(skill => basename(skill.baseDir) === selector || skill.name === selector)
    if (matches.length === 1) return resolve(matches[0].baseDir)
    if (matches.length > 1) {
      const paths = matches.map(skill => relative(root, skill.baseDir)).join(', ')
      throw Error(`Skill name ${selector} is ambiguous in ${source.repository}: ${paths}.`)
    }
  }
  if (await exists(join(root, 'SKILL.md'))) {
    if (!source.requestedPath) return root
    const loaded = loadSkillsFromDir({ dir: root, source: 'remote' })
    const rootSkill = loaded.skills.find(skill => resolve(skill.baseDir) === root)
    const selector = source.requestedPath.split('/').filter(Boolean).at(-1)
    if (selector === source.repository || selector === rootSkill?.name) return root
  }
  if (!source.requestedPath) return root
  throw Error(`No SKILL.md was found at ${source.requestedPath}.`)
}

async function restrictPackageToSkills(packages: DefaultPackageManager, settings: SettingsManager, source: string) {
  const installedPath = packages.getInstalledPath(source, 'user')
  const current = settings.getGlobalSettings().packages || []
  const next = current.map(item => {
    const itemSource = typeof item === 'string' ? item : item.source
    const itemPath = packages.getInstalledPath(itemSource, 'user')
    if (installedPath && itemPath && resolve(itemPath) === resolve(installedPath)) {
      return { ...(typeof item === 'string' ? { source: item } : item), extensions: [], prompts: [], themes: [] }
    }
    return item
  })
  settings.setPackages(next)
}

function validPackageSource(value: string) {
  const source = String(value || '').trim()
  if (!source || source.length > 2_048 || /[\u0000-\u001f\u007f]/.test(source)) throw Error('Enter a valid Skill package source.')
  if (!/^(?:npm:|git:|https?:\/\/|ssh:\/\/|\/|[A-Za-z]:[\\/]|\.\.?[\\/])/.test(source)) throw Error('Use npm:, git:, an HTTP(S)/SSH URL, or a local path.')
  return source
}

function validName(value: string) {
  const name = String(value || '').trim()
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) || name.length > 64) throw Error('Skill name must be 1–64 lowercase letters, numbers, or single hyphens.')
  return name
}

function validDescription(value: string) {
  const description = String(value || '').replace(/\s+/g, ' ').trim()
  if (!description || description.length > 1_024) throw Error('Skill description must be 1–1024 characters.')
  return description
}

function yamlString(value: string) {
  return JSON.stringify(value)
}

function skillMarkdown(name: string, description: string, instructions: string, disableModelInvocation: boolean) {
  return serializeManagedSkillMarkdown(name, description, disableModelInvocation, [], skillBody(name, instructions))
}

function skillBody(name: string, instructions: string) {
  return `# ${name.split('-').map(part => part[0]?.toUpperCase() + part.slice(1)).join(' ')}\n\n${instructions.trim()}\n`
}

function managedSkillMarkdown(content: string) {
  const match = String(content || '').match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)
  if (!match) throw Error('Skill instructions do not have valid frontmatter.')
  const lines = match[1].split(/\r?\n/)
  const disableModelInvocation = lines.some(line => /^disable-model-invocation:\s*true\s*$/i.test(line))
  const extraFrontmatter = lines.filter(line => !/^(?:name|description|disable-model-invocation):/i.test(line))
  return {
    disableModelInvocation,
    extraFrontmatter,
    body: content.slice(match[0].length).replace(/^\r?\n/, ''),
  }
}

function serializeManagedSkillMarkdown(name: string, description: string, disableModelInvocation: boolean, extraFrontmatter: string[], body: string) {
  const frontmatter = [
    `name: ${name}`,
    `description: ${yamlString(description)}`,
    ...(disableModelInvocation ? ['disable-model-invocation: true'] : []),
    ...extraFrontmatter,
  ]
  return `---\n${frontmatter.join('\n')}\n---\n\n${body.trim()}\n`
}

async function validateSkillMarkdown(content: string, expectedName: string) {
  if (Buffer.byteLength(content) > MAX_SKILL_MARKDOWN) throw Error('SKILL.md is too large.')
  const root = await mkdtemp(join(tmpdir(), 'shun-skill-'))
  try {
    await writeFile(join(root, 'SKILL.md'), content, 'utf8')
    const result = loadSkillsFromDir({ dir: root, source: 'validation' })
    const skill = result.skills[0]
    if (!skill) throw Error(result.diagnostics.map(item => item.message).join('\n') || 'This is not a valid Agent Skill.')
    validName(skill.name)
    validDescription(skill.description)
    if (skill.name !== expectedName) throw Error(`SKILL.md name must remain ${expectedName}. Create a new Skill to use a different name.`)
    const error = result.diagnostics.find(item => item.type === 'error')
    if (error) throw Error(error.message)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

async function copySkillTree(source: string, destination: string) {
  let files = 0
  let bytes = 0
  async function copyDirectory(current: string, target: string) {
    await mkdir(target, { recursive: true })
    for (const entry of await readdir(current, { withFileTypes: true })) {
      if (ignoredEntries.has(entry.name)) continue
      const from = join(current, entry.name)
      const to = join(target, entry.name)
      const info = await lstat(from)
      if (info.isSymbolicLink()) throw Error(`Skill imports cannot contain symbolic links: ${relative(source, from)}`)
      if (info.isDirectory()) {
        await copyDirectory(from, to)
        continue
      }
      if (!info.isFile()) continue
      files++
      bytes += info.size
      if (files > MAX_SKILL_FILES || bytes > MAX_SKILL_BYTES) throw Error('Skill import exceeds the 400-file or 25 MB safety limit.')
      await copyFile(from, to, constants.COPYFILE_EXCL)
    }
  }
  await copyDirectory(source, destination)
}

async function exists(path: string) {
  try { await access(path); return true } catch { return false }
}

async function readOptional(path: string) {
  try { return await readFile(path, 'utf8') } catch { return '' }
}

async function pythonScripts(root: string) {
  const scripts: string[] = []
  async function walk(directory: string) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (ignoredEntries.has(entry.name) || entry.name === '.venv' || entry.name === 'venv' || entry.name === '__pycache__') continue
      const path = join(directory, entry.name)
      if (entry.isDirectory()) await walk(path)
      else if (entry.isFile() && entry.name.endsWith('.py')) scripts.push(relative(root, path))
      if (scripts.length > 100) throw Error('Skill contains too many Python scripts to prepare safely.')
    }
  }
  await walk(root)
  return scripts.sort()
}

type PythonCommand = { command: string; args: string[] }

async function systemPython(): Promise<PythonCommand> {
  const candidates: PythonCommand[] = process.platform === 'win32'
    ? [{ command: 'py', args: ['-3'] }, { command: 'python', args: [] }, { command: 'python3', args: [] }]
    : [{ command: 'python3', args: [] }, { command: 'python', args: [] }]
  for (const candidate of candidates) try {
    await execFileAsync(candidate.command, [...candidate.args, '--version'], { timeout: 5_000 })
    return candidate
  } catch {}
  throw Error('Python 3 is required to run this Skill, but no Python interpreter was found.')
}

export function pythonImportModules(content: string) {
  const modules = new Set<string>()
  for (const match of content.matchAll(/^\s*(?:from|import)\s+([A-Za-z_][A-Za-z0-9_]*)/gm)) modules.add(match[1])
  modules.delete('__future__')
  return [...modules].sort()
}

async function inferredPythonDependencies(files: string[], python: PythonCommand) {
  const imports = new Set<string>()
  const local = new Set<string>()
  for (const file of files) {
    local.add(basename(file, '.py'))
    const content = await readFile(file, 'utf8')
    if (content.length > 2 * 1024 * 1024) throw Error(`Python script is too large to inspect: ${basename(file)}`)
    for (const name of pythonImportModules(content)) imports.add(name)
  }
  const { stdout } = await execFileAsync(python.command, [...python.args, '-c', 'import json,sys; print(json.dumps(sorted(getattr(sys, "stdlib_module_names", []))))'], { timeout: 5_000 })
  const standard = new Set<string>(JSON.parse(stdout || '[]'))
  return [...imports].filter(name => !standard.has(name) && !local.has(name)).sort()
}
