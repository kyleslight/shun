import { cp, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'

const pluginIdPattern = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/

export type PluginScaffoldInput = {
  workspaceRoot: string
  templateRoot: string
  path: string
  pluginId: string
  name: string
  description: string
  userOutcome: string
  primaryFlow: string
  iconConcept?: string
  publisher?: string
}

export type PluginScaffoldResult = {
  root: string
  relativePath: string
  createdFiles: string[]
}

export async function scaffoldPluginPackage(input: PluginScaffoldInput): Promise<PluginScaffoldResult> {
  const workspaceRoot = resolve(input.workspaceRoot)
  const requestedPath = input.path.trim()
  if (!requestedPath) throw Error('Plugin scaffold path is required.')
  const target = resolve(workspaceRoot, requestedPath)
  if (target !== workspaceRoot && !target.startsWith(`${workspaceRoot}${sep}`)) throw Error('Plugin scaffold path must resolve inside the selected workspace.')
  const relativePath = relative(workspaceRoot, target) || '.'
  const workspaceRootTarget = target === workspaceRoot
  if (!workspaceRootTarget && await pathExists(target)) throw Error(`Plugin scaffold target already exists: ${relative(workspaceRoot, target)}`)

  const pluginId = input.pluginId.trim()
  if (!pluginIdPattern.test(pluginId) || pluginId.length > 80) throw Error('Plugin id must be lowercase dot or hyphen notation.')
  const name = requiredText(input.name, 'Plugin name', 100)
  const description = requiredText(input.description, 'Plugin description', 500)
  const userOutcome = requiredText(input.userOutcome, 'Plugin user outcome', 1_000)
  const primaryFlow = requiredText(input.primaryFlow, 'Plugin primary flow', 2_000)
  const publisher = optionalText(input.publisher, 'Plugin publisher', 100) || 'Local developer'
  const iconConcept = optionalText(input.iconConcept, 'Plugin icon concept', 300) || `A distinct symbol expressing ${name}`

  const templateRoot = resolve(input.templateRoot)
  await Promise.all([
    requireTemplateFile(templateRoot, 'manifest.json'),
    requireTemplateFile(templateRoot, 'ui/index.html'),
    requireTemplateFile(templateRoot, 'ui/styles.css'),
    requireTemplateFile(templateRoot, 'ui/shun-host.js'),
    requireTemplateFile(templateRoot, 'ui/app.js'),
  ])

  const staging = await mkdtemp(join(workspaceRoot, '.shun-plugin-scaffold-'))
  const movedIntoWorkspaceRoot: string[] = []
  try {
    await cp(templateRoot, staging, { recursive: true, force: true })
    const manifest = {
      schemaVersion: 1,
      id: pluginId,
      name,
      description,
      version: '0.1.0',
      publisher,
      icon: 'icon.svg',
      experimental: true,
      runtime: { workspace: 'required' },
      permissions: [],
      contributes: {
        views: [{ id: `${pluginId}.main`, title: name, location: 'workspace.right', entry: 'ui/index.html', rail: 'on-demand', launch: ['user', 'assistant'] }],
      },
    }
    await writeFile(join(staging, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
    await writeFile(join(staging, 'PRODUCT_BRIEF.md'), productBrief({ name, description, userOutcome, primaryFlow, iconConcept }), 'utf8')
    await writeFile(join(staging, 'icon.svg'), starterIcon(input.pluginId, name), 'utf8')
    const indexPath = join(staging, 'ui', 'index.html')
    const indexHtml = await readFile(indexPath, 'utf8')
    await writeFile(indexPath, indexHtml.replaceAll('Example Plugin', escapeHtml(name)), 'utf8')

    if (workspaceRootTarget) {
      const entries = await readdir(staging)
      for (const entry of entries) if (await pathExists(join(target, entry))) throw Error(`Plugin scaffold target already contains ${entry}. Choose a new package directory or remove that collision first.`)
      for (const entry of entries) {
        await rename(join(staging, entry), join(target, entry))
        movedIntoWorkspaceRoot.push(join(target, entry))
      }
      await rm(staging, { recursive: true, force: true })
    } else {
      await mkdir(dirname(target), { recursive: true })
      if (await pathExists(target)) throw Error(`Plugin scaffold target already exists: ${relative(workspaceRoot, target)}`)
      await rename(staging, target)
    }
    return {
      root: target,
      relativePath: relative(workspaceRoot, target) || '.',
      createdFiles: ['manifest.json', 'PRODUCT_BRIEF.md', 'icon.svg', 'ui/index.html', 'ui/styles.css', 'ui/shun-host.js', 'ui/app.js'],
    }
  } catch (error) {
    for (const path of movedIntoWorkspaceRoot.reverse()) await rm(path, { recursive: true, force: true }).catch(() => {})
    await rm(staging, { recursive: true, force: true }).catch(() => {})
    throw error
  }
}

async function requireTemplateFile(templateRoot: string, path: string) {
  const file = resolve(templateRoot, path)
  if (!file.startsWith(`${templateRoot}${sep}`) || !(await lstat(file)).isFile()) throw Error(`Plugin scaffold template is incomplete: ${path}`)
}

async function pathExists(path: string) {
  return lstat(path).then(() => true, error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  })
}

function requiredText(value: unknown, label: string, maxLength: number) {
  const text = String(value || '').trim()
  if (!text || text.length > maxLength) throw Error(`${label} must contain 1-${maxLength} characters.`)
  return text
}

function optionalText(value: unknown, label: string, maxLength: number) {
  const text = String(value || '').trim()
  if (text.length > maxLength) throw Error(`${label} must contain at most ${maxLength} characters.`)
  return text
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!)
}

function productBrief(input: { name: string; description: string; userOutcome: string; primaryFlow: string; iconConcept: string }) {
  return `# ${input.name}

${input.description}

## Outcome

${input.userOutcome}

## Primary flow

${input.primaryFlow}

## Product constraints

- Keep the conversation visible; the view belongs in \`workspace.right\`.
- Use the generated \`ui/shun-host.js\` client as the host boundary.
- Keep project-specific state workspace-scoped.
- Validate, install/reload, and exercise this primary flow before handoff.

## Icon direction

${input.iconConcept}. Replace the generated starting icon with a distinct small-size identity.
`
}

function starterIcon(pluginId: string, name: string) {
  let hash = 2166136261
  for (const character of pluginId) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619) >>> 0
  const hue = hash % 360, second = (hue + 48 + (hash >>> 8) % 72) % 360, turn = 8 + (hash % 13)
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" role="img" aria-label="${escapeHtml(name)} icon">
  <defs><linearGradient id="g" x1="8" y1="6" x2="56" y2="58" gradientUnits="userSpaceOnUse"><stop stop-color="hsl(${hue} 78% 62%)"/><stop offset="1" stop-color="hsl(${second} 72% 48%)"/></linearGradient></defs>
  <rect x="5" y="5" width="54" height="54" rx="15" fill="url(#g)"/>
  <path d="M18 ${18 + turn} 32 14l14 ${4 + turn}v18L32 50 18 36Z" fill="none" stroke="white" stroke-width="5" stroke-linejoin="round" opacity=".94"/>
  <circle cx="32" cy="32" r="4" fill="white"/>
</svg>\n`
}
