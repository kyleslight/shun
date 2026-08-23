import assert from 'node:assert/strict'
import test from 'node:test'
import { configuredPlugin, enabledPluginIds, enabledPluginSkillDocuments, enabledSkillStates, installPlugin, migratePluginSettings, pluginManifests, pluginStates, readEnabledSkill, skillStates } from './plugins.ts'

test('first-party plugin manifests expose real phase-one connectors', () => {
  const manifests = pluginManifests()
  assert.deepEqual(manifests.map(item => item.id), ['github', 'figma', 'browser-use'])
  assert.equal(manifests[0].connector.kind, 'github-cli')
  assert.equal(manifests[0].connector.auth, 'cli')
  assert.equal(manifests[1].connector.kind, 'figma-rest')
  assert.equal(manifests[1].connector.auth, 'pat')
  assert.equal(manifests[2].connector.kind, 'chrome-extension')
  assert.equal(manifests[2].connector.auth, 'extension')
  assert.deepEqual(manifests.flatMap(item => item.bundledSkills.map(skill => skill.id)), ['github-pull-requests', 'figma-design-context', 'chrome-browser-control'])
})

test('legacy plugin-owned MCP entries migrate to native plugin installations without retaining plaintext tokens', () => {
  const migrated = migratePluginSettings({
    plugins: [],
    mcpServers: [
      { id: 'github', name: 'GitHub', command: 'github-mcp-server', pluginId: 'github', env: { GITHUB_PERSONAL_ACCESS_TOKEN: 'secret' } },
      { id: 'figma', name: 'Figma', url: 'https://mcp.figma.com/mcp', pluginId: 'figma', enabled: false },
      { id: 'other', name: 'Other', url: 'https://example.com/mcp' },
    ],
  })
  assert.deepEqual(migrated.plugins, [{ id: 'github', enabled: true }, { id: 'figma', enabled: false }])
  assert.deepEqual(migrated.mcpServers, [{ id: 'other', name: 'Other', url: 'https://example.com/mcp' }])
  assert.doesNotMatch(JSON.stringify(migrated), /secret/)
})

test('plugin installation and enablement are explicit product settings', () => {
  const plugins = installPlugin({ plugins: [], mcpServers: [] }, 'github')
  assert.equal(plugins.length, 1)
  assert.equal(configuredPlugin({ plugins, mcpServers: [] }, 'github')?.id, 'github')
  assert.deepEqual(pluginStates({ plugins, mcpServers: [] }).map(item => [item.id, item.installed, item.enabled]), [
    ['github', true, true],
    ['figma', false, false],
    ['browser-use', false, false],
  ])
  plugins[0].enabled = false
  assert.equal(pluginStates({ plugins, mcpServers: [] })[0].enabled, false)
})

test('installing a plugin is idempotent', () => {
  const once = installPlugin({ plugins: [], mcpServers: [] }, 'figma')
  assert.equal(installPlugin({ plugins: once, mcpServers: [] }, 'figma').length, 1)
})

test('skills are real plugin capabilities and instructions stay behind an enabled boundary', () => {
  const configured = { plugins: installPlugin({ plugins: [], mcpServers: [] }, 'github'), mcpServers: [] }
  assert.deepEqual(skillStates(configured).map(skill => [skill.id, skill.installed, skill.enabled]), [
    ['github-pull-requests', true, true],
    ['figma-design-context', false, false],
    ['chrome-browser-control', false, false],
  ])
  assert.deepEqual([...enabledPluginIds(configured)], ['github'])
  assert.deepEqual(enabledSkillStates(configured).map(skill => skill.id), ['github-pull-requests'])
  assert.deepEqual(enabledPluginSkillDocuments(configured).map(skill => skill.id), ['github-pull-requests'])
  assert.match(enabledPluginSkillDocuments(configured)[0].instructions, /filesystem Git state.*source of truth/i)
  assert.match(readEnabledSkill(configured, 'github-pull-requests').instructions, /filesystem Git state.*source of truth/i)
  assert.throws(() => readEnabledSkill(configured, 'figma-design-context'), /Unknown or disabled plugin Skill.*Enable its plugin/)

  const browser = { plugins: installPlugin({ plugins: [], mcpServers: [] }, 'browser-use'), mcpServers: [] }
  assert.match(readEnabledSkill(browser, 'chrome-browser-control').instructions, /browser_claim an existing tab/i)
  assert.match(readEnabledSkill(browser, 'chrome-browser-control').instructions, /external mutations/i)
})

test('bundled skills have independent durable enablement under their plugin', () => {
  const configured = { plugins: [{ id: 'github', enabled: true, skills: { 'github-pull-requests': false, unknown: false } }], mcpServers: [] }
  const migrated = migratePluginSettings(configured)
  assert.deepEqual(migrated.plugins, [{ id: 'github', enabled: true, skills: { 'github-pull-requests': false } }])
  assert.equal(skillStates(migrated)[0].installed, true)
  assert.equal(skillStates(migrated)[0].enabled, false)
  assert.deepEqual(enabledSkillStates(migrated), [])
  assert.throws(() => readEnabledSkill(migrated, 'github-pull-requests'), /Unknown or disabled plugin Skill.*Enable its plugin/)

  const pluginOff = { plugins: [{ id: 'github', enabled: false, skills: { 'github-pull-requests': true } }], mcpServers: [] }
  assert.equal(skillStates(pluginOff)[0].enabled, false)
})
