import assert from 'node:assert/strict'
import test from 'node:test'
import { applyDefaultPluginInstallations, fileManagerPermissions, gitWorkbenchPermissions, pluginDefaultsVersion, sitesPermissions, terminalPermissions } from '../shared.ts'
import { configuredPlugin, enabledPluginIds, enabledPluginSkillDocuments, enabledSkillStates, installPlugin, migratePluginSettings, pluginManifests, pluginStates, readEnabledSkill, skillStates } from './plugins.ts'
import { oauthClientRegistration } from './oauth-clients.ts'

test('built-in workspace utilities are installed by default exactly once', () => {
  const initial = applyDefaultPluginInstallations({ plugins: [] })
  assert.deepEqual(initial, {
    plugins: [
      { id: 'git-workbench', enabled: true, permissions: gitWorkbenchPermissions },
      { id: 'file-manager', enabled: true, permissions: fileManagerPermissions },
      { id: 'browser-preview', enabled: true, permissions: [] },
      { id: 'terminal', enabled: true, permissions: terminalPermissions },
      { id: 'sites', enabled: true, permissions: sitesPermissions },
    ],
    pluginDefaultsVersion,
  })
  assert.deepEqual(
    applyDefaultPluginInstallations({ plugins: [], pluginDefaultsVersion }),
    { plugins: [], pluginDefaultsVersion },
  )
  assert.deepEqual(
    applyDefaultPluginInstallations({ plugins: [{ id: 'git-workbench', enabled: true, permissions: gitWorkbenchPermissions }], pluginDefaultsVersion: 1 }).plugins,
    [
      { id: 'git-workbench', enabled: true, permissions: gitWorkbenchPermissions },
      { id: 'file-manager', enabled: true, permissions: fileManagerPermissions },
      { id: 'browser-preview', enabled: true, permissions: [] },
      { id: 'terminal', enabled: true, permissions: terminalPermissions },
      { id: 'sites', enabled: true, permissions: sitesPermissions },
    ],
  )
  assert.deepEqual(
    applyDefaultPluginInstallations({ plugins: [{ id: 'git-workbench', enabled: false }, { id: 'file-manager', enabled: false }], pluginDefaultsVersion: 0 }).plugins,
    [{ id: 'git-workbench', enabled: false }, { id: 'file-manager', enabled: false }, { id: 'browser-preview', enabled: true, permissions: [] }, { id: 'terminal', enabled: true, permissions: terminalPermissions }, { id: 'sites', enabled: true, permissions: sitesPermissions }],
  )
})

test('first-party plugin manifests expose real phase-one connectors', () => {
  const manifests = pluginManifests()
  assert.deepEqual(manifests.map(item => item.id), ['github', 'figma', 'gmail', 'browser-use', 'ios-simulator', 'computer-use', 'godot', 'render', 'cloudflare'])
  assert.equal(manifests[0].connector.kind, 'github-cli')
  assert.equal(manifests[0].connector.auth, 'cli')
  assert.equal(manifests[1].connector.kind, 'figma-rest')
  assert.equal(manifests[1].connector.auth, 'pat')
  assert.equal(manifests[2].connector.kind, 'gmail-rest')
  assert.equal(manifests[2].connector.auth, 'oauth')
  // Gmail offers one click exactly when this build ships its own Google client.
  assert.equal(Boolean(manifests[2].connector.authorizeLabel), Boolean(oauthClientRegistration('google')))
  assert.equal(manifests[3].connector.kind, 'chrome-extension')
  assert.equal(manifests[3].connector.auth, 'extension')
  assert.equal(manifests[4].connector.kind, 'ios-simulator')
  assert.equal(manifests[4].connector.auth, 'local')
  assert.equal(manifests[5].connector.kind, 'desktop-control')
  assert.equal(manifests[5].connector.auth, 'local')
  assert.equal(manifests[6].connector.kind, 'godot-cli')
  assert.equal(manifests[6].connector.auth, 'local')
  assert.equal(manifests[7].connector.kind, 'render-rest')
  assert.equal(manifests[7].connector.auth, 'api-key')
  assert.equal(manifests[8].connector.kind, 'cloudflare-rest')
  assert.equal(manifests[8].connector.auth, 'api-key')
  assert.deepEqual(manifests.flatMap(item => item.bundledSkills.map(skill => skill.id)), ['github-pull-requests', 'figma-design-context', 'gmail-mailbox', 'chrome-browser-control', 'ios-simulator-control', 'computer-use-control', 'godot-development', 'render-deployments', 'cloudflare-operations'])
  assert.equal(installPlugin({ plugins: [], mcpServers: [] }, 'gmail').length, 1)
  assert.throws(() => installPlugin({ plugins: [], mcpServers: [] }, 'nope'), /Unknown plugin/)
  assert.equal(pluginManifests('linux').some(item => item.id === 'ios-simulator'), false)
  // Computer Use ships a driver for every desktop platform, so it is offered on all
  // three and each driver reports what its own session can honestly do.
  assert.equal(pluginManifests('linux').some(item => item.id === 'computer-use'), true)
  assert.equal(pluginManifests('win32').some(item => item.id === 'computer-use'), true)
  assert.equal(skillStates({ plugins: [], mcpServers: [], skills: [] }).find(skill => skill.id === 'cloudflare-operations')?.icon, 'cloudflare')
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
    ['gmail', false, false],
    ['browser-use', false, false],
    ['ios-simulator', false, false],
    ['computer-use', false, false],
    ['godot', false, false],
    ['render', false, false],
    ['cloudflare', false, false],
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
    ['gmail-mailbox', false, false],
    ['chrome-browser-control', false, false],
    ['ios-simulator-control', false, false],
    ['computer-use-control', false, false],
    ['godot-development', false, false],
    ['render-deployments', false, false],
    ['cloudflare-operations', false, false],
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

  const simulator = { plugins: installPlugin({ plugins: [], mcpServers: [] }, 'ios-simulator'), mcpServers: [] }
  assert.match(readEnabledSkill(simulator, 'ios-simulator-control').instructions, /ios_simulator_snapshot/i)
  assert.match(readEnabledSkill(simulator, 'ios-simulator-control').instructions, /instead of changing application code/i)

  const desktop = { plugins: installPlugin({ plugins: [], mcpServers: [] }, 'computer-use'), mcpServers: [] }
  assert.match(readEnabledSkill(desktop, 'computer-use-control').instructions, /desktop_snapshot/i)
  assert.match(readEnabledSkill(desktop, 'computer-use-control').instructions, /belongs to Browser Use/i)
  assert.match(readEnabledSkill(desktop, 'computer-use-control').instructions, /refused while someone is typing or moving the pointer/i)
  assert.match(readEnabledSkill(desktop, 'computer-use-control').instructions, /desktop_elements.*prefer it for a named control/i)
  assert.match(readEnabledSkill(desktop, 'computer-use-control').instructions, /refuses a ref that no longer matches/i)

  const godot = { plugins: installPlugin({ plugins: [], mcpServers: [] }, 'godot'), mcpServers: [] }
  assert.match(readEnabledSkill(godot, 'godot-development').instructions, /godot_script_check/i)
  assert.match(readEnabledSkill(godot, 'godot-development').instructions, /background_start/i)

  const render = { plugins: installPlugin({ plugins: [], mcpServers: [] }, 'render'), mcpServers: [] }
  assert.match(readEnabledSkill(render, 'render-deployments').instructions, /explicitly asks to deploy/i)

  const cloudflare = { plugins: installPlugin({ plugins: [], mcpServers: [] }, 'cloudflare'), mcpServers: [] }
  assert.match(readEnabledSkill(cloudflare, 'cloudflare-operations').instructions, /full-zone cache purge.*broad and disruptive/i)
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
