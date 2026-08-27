import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { SkillManager, parseGitHubSkillSource, pythonDistributionName, pythonImportModules, resolveGitHubSkillTarget, skillCatalogQuery, skillEnabled, skillInstallationId } from './skill-manager.ts'

test('Skill catalog queries describe remote installable candidates rather than local state', () => {
  assert.equal(skillCatalogQuery('Figma design review'), 'installable Agent Skills SKILL.md packages for Figma design review')
  assert.equal(skillCatalogQuery(''), 'installable Agent Skills SKILL.md catalogs and repositories')
})

test('GitHub Skill sources accept repository URLs and owner/repository/skill shorthand', () => {
  assert.deepEqual(parseGitHubSkillSource('lanyasheng/trading-quant/trading-quant'), {
    cloneUrl: 'https://github.com/lanyasheng/trading-quant.git',
    repository: 'trading-quant',
    requestedPath: 'trading-quant',
  })
  assert.deepEqual(parseGitHubSkillSource('https://github.com/lanyasheng/trading-quant'), {
    cloneUrl: 'https://github.com/lanyasheng/trading-quant.git',
    repository: 'trading-quant',
  })
  assert.equal(parseGitHubSkillSource('npm:@example/skills'), null)
})

test('GitHub Skill targets resolve conventional and accidentally repeated skills directories', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shun-github-skills-'))
  await mkdir(join(root, 'skills', 'yahoo-finance'), { recursive: true })
  await mkdir(join(root, 'skills', 'tradingview'), { recursive: true })
  await writeFile(join(root, 'skills', 'yahoo-finance', 'SKILL.md'), '---\nname: yahoo-finance\ndescription: Read Yahoo Finance market data.\n---\n')
  await writeFile(join(root, 'skills', 'tradingview', 'SKILL.md'), '---\nname: tradingview\ndescription: Read TradingView market data.\n---\n')

  assert.equal(await resolveGitHubSkillTarget(root, parseGitHubSkillSource('gauss314/skills/yahoo-finance')!), join(root, 'skills', 'yahoo-finance'))
  assert.equal(await resolveGitHubSkillTarget(root, parseGitHubSkillSource('gauss314/skills/skills/tradingview')!), join(root, 'skills', 'tradingview'))
  assert.equal(await resolveGitHubSkillTarget(root, parseGitHubSkillSource('gauss314/skills/skills/skills/yahoo-finance')!), join(root, 'skills', 'yahoo-finance'))
})

test('Python Skill dependency discovery separates imported module names from script text', () => {
  assert.deepEqual(pythonImportModules([
    'from __future__ import annotations',
    'import requests',
    'from curl_cffi import requests as browser_requests',
    '  import json',
    '# import ignored_comment',
  ].join('\n')), ['curl_cffi', 'json', 'requests'])
  assert.equal(pythonDistributionName('PIL'), 'Pillow')
  assert.equal(pythonDistributionName('requests'), 'requests')
})

test('local Agent Skills support create, edit, disable, and remove', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shun-skills-'))
  const manager = new SkillManager(join(root, 'agent'))
  const created = await manager.create({
    name: 'design-review',
    description: 'Reviews UI implementation decisions. Use for design review tasks.',
    instructions: 'Inspect the relevant design and implementation before reporting gaps.',
  })
  assert.equal(created.skill.id, skillInstallationId('design-review'))
  assert.equal(created.skill.origin, 'local')
  assert.equal(created.skill.editable, true)
  assert.match(created.content, /^---\nname: design-review\ndescription:/)
  assert.equal((await manager.read('design-review', {})).skill.id, skillInstallationId('design-review'))

  const disabled = { skills: [{ id: skillInstallationId('design-review'), enabled: false }] }
  assert.equal(skillEnabled(disabled, 'design-review'), false)
  assert.equal((await manager.list(disabled))[0].enabled, false)

  const changed = created.content.replace('before reporting gaps.', 'and report concrete gaps.')
  const updated = await manager.update(created.skill.id, changed, disabled)
  assert.match(updated.content, /report concrete gaps/)
  await assert.rejects(() => manager.update(created.skill.id, changed.replace('name: design-review', 'name: renamed'), disabled), /name must remain design-review/)

  const appended = await manager.updateManaged({
    name: 'design-review',
    description: 'Reviews implemented interfaces. Use when the user requests a design review.',
    appendInstructions: 'Always identify the highest-impact mismatch first.',
    disableModelInvocation: true,
  }, disabled)
  assert.equal(appended.skill.description, 'Reviews implemented interfaces. Use when the user requests a design review.')
  assert.match(appended.content, /disable-model-invocation: true/)
  assert.match(appended.content, /Always identify the highest-impact mismatch first\./)

  const patched = await manager.updateManaged({
    name: 'design-review',
    instructionPatch: { find: 'highest-impact mismatch', replace: 'highest-impact visual mismatch' },
  }, disabled)
  assert.match(patched.content, /highest-impact visual mismatch/)
  await assert.rejects(() => manager.updateManaged({ name: 'design-review' }, disabled), /at least one Skill change/)
  await assert.rejects(() => manager.updateManaged({ name: 'design-review', instructions: 'Replace everything.', appendInstructions: 'Append this.' }, disabled), /Choose one instruction update/)

  assert.equal(await manager.remove(created.skill.id, disabled), true)
  assert.deepEqual(await manager.list(disabled), [])
})

test('Skill imports copy a bounded self-contained directory and reject symbolic links', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shun-skill-import-'))
  const source = join(root, 'source')
  const agent = join(root, 'agent')
  await mkdir(join(source, 'references'), { recursive: true })
  await writeFile(join(source, 'SKILL.md'), '---\nname: imported-skill\ndescription: Imported test Skill.\n---\n\nRead references/guide.md.\n')
  await writeFile(join(source, 'references', 'guide.md'), '# Guide\n')
  const manager = new SkillManager(agent)
  const imported = await manager.importPath(source)
  assert.deepEqual(imported.map(item => item.name), ['imported-skill'])
  assert.equal(await readFile(join(agent, 'skills', 'imported-skill', 'references', 'guide.md'), 'utf8'), '# Guide\n')

  const unsafe = join(root, 'unsafe')
  await mkdir(unsafe)
  await writeFile(join(unsafe, 'SKILL.md'), '---\nname: unsafe-skill\ndescription: Unsafe test Skill.\n---\n')
  await symlink(join(source, 'references'), join(unsafe, 'linked'))
  await assert.rejects(() => manager.importPath(unsafe), /cannot contain symbolic links/)
})

test('Skill package installation is persisted with non-Skill resources disabled', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shun-skill-package-'))
  const agent = join(root, 'agent')
  const cwd = join(root, 'workspace')
  const source = join(root, 'package')
  await mkdir(join(source, 'skills', 'package-skill'), { recursive: true })
  await mkdir(cwd)
  await writeFile(join(source, 'package.json'), JSON.stringify({ name: 'test-agent-skills', private: true }))
  await writeFile(join(source, 'skills', 'package-skill', 'SKILL.md'), '---\nname: package-skill\ndescription: Skill supplied by an Agent Skills package.\n---\n\nFollow the package workflow.\n')

  const manager = new SkillManager(agent)
  const installed = await manager.installPackage(source, { skills: [] }, cwd)
  assert.deepEqual(installed.map(item => [item.name, item.origin]), [['package-skill', 'package']])
  const settings = JSON.parse(await readFile(join(agent, 'settings.json'), 'utf8'))
  assert.deepEqual(settings.packages, [{ source: '../package', extensions: [], prompts: [], themes: [] }])

  assert.equal(await manager.removePackage(source, cwd), true)
  assert.deepEqual((await manager.list({ skills: [] }, cwd)).filter(item => item.name === 'package-skill'), [])
})

test('multi-Skill sources require a textual selection before installing only confirmed members', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shun-skill-selection-'))
  const agent = join(root, 'agent')
  const cwd = join(root, 'workspace')
  const source = join(root, 'package')
  await mkdir(cwd)
  await mkdir(join(source, 'skills', 'analytics'), { recursive: true })
  await mkdir(join(source, 'skills', 'copywriting'), { recursive: true })
  await writeFile(join(source, 'package.json'), JSON.stringify({ name: 'community-marketing-skills', private: true }))
  await writeFile(join(source, 'skills', 'analytics', 'SKILL.md'), '---\nname: analytics\ndescription: Analyze product and campaign performance.\n---\n')
  await writeFile(join(source, 'skills', 'copywriting', 'SKILL.md'), '---\nname: copywriting\ndescription: Write and revise marketing copy.\n---\n')

  const manager = new SkillManager(agent)
  const inspection = await manager.requestInstall(source, { skills: [] }, cwd)
  assert.equal(inspection.status, 'selection_required')
  if (inspection.status !== 'selection_required') return
  assert.deepEqual(inspection.candidates.map(candidate => candidate.name), ['analytics', 'copywriting'])
  assert.deepEqual((await manager.list({ skills: [] }, cwd)).filter(item => ['analytics', 'copywriting'].includes(item.name)), [])

  await assert.rejects(
    () => manager.requestInstall(source, { skills: [] }, cwd, { inspectionToken: inspection.inspectionToken, skills: ['unknown-skill'] }),
    /does not contain: unknown-skill/,
  )
  const installed = await manager.requestInstall(source, { skills: [] }, cwd, {
    inspectionToken: inspection.inspectionToken,
    skills: ['copywriting'],
  })
  assert.equal(installed.status, 'installed')
  if (installed.status !== 'installed') return
  assert.deepEqual(installed.installed.map(skill => skill.name), ['copywriting'])
  assert.deepEqual((await manager.list({ skills: [] }, cwd)).filter(item => ['analytics', 'copywriting'].includes(item.name)).map(item => item.name), ['copywriting'])
  const settings = JSON.parse(await readFile(join(agent, 'settings.json'), 'utf8'))
  assert.deepEqual(settings.packages, [{ source: '../package', autoload: false, skills: ['skills/copywriting/SKILL.md'], extensions: [], prompts: [], themes: [] }])
})
