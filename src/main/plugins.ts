import type { PluginInstallation, PluginManifest, PluginState, Settings, SkillState } from '../shared.ts'

const manifests: PluginManifest[] = [
  {
    id: 'github',
    name: 'GitHub',
    description: 'Work with repositories, issues, pull requests, reviews, checks, and Actions.',
    version: '1',
    publisher: 'GitHub · GitHub CLI',
    icon: 'github',
    connector: {
      kind: 'github-cli',
      setupLabel: 'Connect with GitHub CLI',
      setupUrl: 'https://cli.github.com/',
      auth: 'cli',
    },
    bundledSkills: [{
      id: 'github-pull-requests',
      name: 'GitHub pull requests',
      description: 'Inspect repository state, issues, pull requests, reviews, checks, and Actions.',
      pluginId: 'github',
    }],
  },
  {
    id: 'figma',
    name: 'Figma',
    description: 'Read linked Figma files, nodes, rendered previews, variables, and image assets.',
    version: '1',
    publisher: 'Figma · REST API',
    icon: 'figma',
    connector: {
      kind: 'figma-rest',
      setupLabel: 'Connect with a Personal Access Token',
      setupUrl: 'https://developers.figma.com/docs/rest-api/personal-access-tokens/',
      auth: 'pat',
    },
    bundledSkills: [{
      id: 'figma-design-context',
      name: 'Figma design context',
      description: 'Inspect linked Figma designs and assets before implementing UI.',
      pluginId: 'figma',
    }],
  },
]

// Independent skills live in this catalog and have their own installation state.
// Plugin-bundled skills remain in their plugin manifest because their tools may depend on that plugin.
const independentSkillManifests: SkillState[] = []

const skillInstructions: Record<string, string> = {
  'github-pull-requests': [
    'Use filesystem Git state as the source of truth for the current branch and local changes.',
    'Use the registered github_* tools only when remote GitHub context or an explicit GitHub action is needed.',
    'Use github_repo_list for account-level repository lists. Use github_repository only for one explicit owner/name repository or the Git-backed task workspace.',
    'Inspect the repository, pull request, checks, and review context before proposing remote changes.',
    'Do not create, update, merge, close, comment on, or publish remote GitHub resources unless the user explicitly asks for that external mutation.',
    'Keep repository identity, branch, base branch, and requested remote action explicit.',
  ].join('\n'),
  'figma-design-context': [
    'Use the registered figma_* tools only when design context is needed.',
    'Use a Figma file or node URL supplied by the user; this REST integration is link-based and read-only.',
    'Inspect only the smallest relevant node tree, rendered preview, variables, and image assets before implementation.',
    'Prefer reusable components, bound variables, and styles over isolated hardcoded values.',
    'Full variable definitions require Figma Enterprise access; treat an unavailable variables endpoint as a plan limitation, not missing design evidence.',
    'Do not claim that this integration can edit the Figma canvas, use Code Connect context, or provide the official MCP get_design_context result.',
  ].join('\n'),
}

export function pluginManifests(): PluginManifest[] {
  return manifests.map(manifest => ({
    ...manifest,
    connector: { ...manifest.connector },
    bundledSkills: manifest.bundledSkills.map(skill => ({ ...skill })),
  }))
}

export function pluginStates(settings: Pick<Settings, 'plugins' | 'mcpServers'>): PluginState[] {
  const migrated = migratePluginSettings(settings)
  return pluginManifests().map(manifest => {
    const installed = migrated.plugins?.find(item => item.id === manifest.id)
    return {
      ...manifest,
      installed: Boolean(installed),
      enabled: Boolean(installed) && installed?.enabled !== false,
      detail: manifest.connector.setupLabel,
    }
  })
}

export function configuredPlugin(settings: Pick<Settings, 'plugins' | 'mcpServers'>, pluginId: string): PluginInstallation | undefined {
  return migratePluginSettings(settings).plugins?.find(item => item.id === pluginId)
}

export function installPlugin(settings: Pick<Settings, 'plugins' | 'mcpServers'>, pluginId: string): PluginInstallation[] {
  pluginManifest(pluginId)
  const current = migratePluginSettings(settings).plugins || []
  return current.some(item => item.id === pluginId)
    ? current.map(item => item.id === pluginId ? { ...item, enabled: true, ...(item.skills ? { skills: { ...item.skills } } : {}) } : { ...item, ...(item.skills ? { skills: { ...item.skills } } : {}) })
    : [...current.map(item => ({ ...item })), { id: pluginId, enabled: true }]
}

export function migratePluginSettings<T extends Pick<Settings, 'plugins' | 'mcpServers'>>(settings: T): T & Pick<Settings, 'plugins' | 'mcpServers'> {
  const known = new Set(manifests.map(item => item.id))
  const plugins = new Map<string, PluginInstallation>()
  for (const item of settings.plugins || []) {
    const manifest = manifests.find(candidate => candidate.id === item.id)
    if (manifest && !plugins.has(item.id)) {
      const skillIds = new Set(manifest.bundledSkills.map(skill => skill.id))
      const skills = Object.fromEntries(Object.entries(item.skills || {}).filter(([skillId, enabled]) => skillIds.has(skillId) && typeof enabled === 'boolean'))
      plugins.set(item.id, { id: item.id, enabled: item.enabled !== false, ...(Object.keys(skills).length ? { skills } : {}) })
    }
  }
  for (const server of settings.mcpServers || []) {
    const pluginId = server.pluginId || (known.has(server.id) ? server.id : undefined)
    if (pluginId && known.has(pluginId) && !plugins.has(pluginId)) plugins.set(pluginId, { id: pluginId, enabled: server.enabled !== false })
  }
  return {
    ...settings,
    plugins: [...plugins.values()],
    mcpServers: (settings.mcpServers || []).filter(server => !known.has(server.pluginId || '') && !known.has(server.id)),
  }
}

export function pluginManifest(pluginId: string) {
  const manifest = manifests.find(item => item.id === pluginId)
  if (!manifest) throw Error(`Unknown plugin: ${pluginId}`)
  return pluginManifests().find(item => item.id === pluginId)!
}

export function enabledPluginIds(settings: Pick<Settings, 'plugins' | 'mcpServers'>) {
  return new Set(pluginStates(settings).filter(item => item.enabled).map(item => item.id))
}

export function skillStates(settings: Pick<Settings, 'plugins' | 'mcpServers' | 'skills'>): SkillState[] {
  const installations = migratePluginSettings(settings).plugins || []
  const independentInstallations = settings.skills || []
  const independent = independentSkillManifests.map(skill => {
    const installation = independentInstallations.find(item => item.id === skill.id)
    return { ...skill, installed: Boolean(installation), enabled: Boolean(installation) && installation?.enabled !== false }
  })
  const bundled = pluginStates(settings).flatMap(plugin => {
    const installation = installations.find(item => item.id === plugin.id)
    return plugin.bundledSkills.map(skill => ({
      ...skill,
      installed: plugin.installed,
      enabled: plugin.enabled && installation?.skills?.[skill.id] !== false,
    }))
  })
  return [...independent, ...bundled]
}

export function enabledSkillStates(settings: Pick<Settings, 'plugins' | 'mcpServers' | 'skills'>) {
  return skillStates(settings).filter(skill => skill.enabled)
}

export function readEnabledSkill(settings: Pick<Settings, 'plugins' | 'mcpServers' | 'skills'>, skillIdValue: unknown) {
  const skillId = String(skillIdValue || '').trim()
  const skill = enabledSkillStates(settings).find(item => item.id === skillId)
  if (!skill) throw Error(`Unknown or disabled skill: ${skillId || '(missing)'}. Call skill_list to see enabled skills.`)
  const instructions = skillInstructions[skill.id]
  if (!instructions) throw Error(`Skill instructions are unavailable: ${skill.id}`)
  return { id: skill.id, name: skill.name, pluginId: skill.pluginId, instructions }
}
