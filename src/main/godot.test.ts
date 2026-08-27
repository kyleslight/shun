import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, realpath, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GodotService, resolveGodotExecutable, type GodotCommandRunner } from './godot.ts'

test('Godot executable resolution prefers conventional editor binaries', () => {
  const executable = resolveGodotExecutable('darwin', '/custom/bin:/usr/bin', path => path === '/Applications/Godot.app/Contents/MacOS/Godot')
  assert.equal(executable, '/Applications/Godot.app/Contents/MacOS/Godot')
  assert.equal(resolveGodotExecutable('linux', '/custom/bin:/usr/bin', path => path === '/custom/bin/godot'), '/custom/bin/godot')
  assert.equal(resolveGodotExecutable('win32', 'C:\\Tools', path => path.endsWith('godot4.exe')), 'C:\\Tools/godot4.exe')
})

test('Godot connection state is local and reports the installed version', async () => {
  const service = new GodotService(async args => {
    assert.deepEqual(args, ['--version'])
    return { stdout: '\u001b[32m4.4.stable.official\u001b[0m\n', stderr: '' }
  }, '/usr/local/bin/godot')
  assert.deepEqual(await service.state(), {
    connected: true,
    status: 'connected',
    account: 'Godot 4.4.stable.official',
    message: 'Godot 4.4.stable.official is available locally.',
  })

  const missing = new GodotService(async () => { throw Object.assign(Error('missing'), { code: 'ENOENT' }) })
  assert.equal((await missing.state()).status, 'unavailable')
})

test('Godot project inspection discovers bounded source metadata and ignores generated state', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'shun-godot-')), project = join(workspace, 'game')
  await mkdir(join(project, 'scenes'), { recursive: true })
  await mkdir(join(project, 'scripts'), { recursive: true })
  await mkdir(join(project, 'addons', 'camera'), { recursive: true })
  await mkdir(join(project, '.godot'), { recursive: true })
  await writeFile(join(project, 'project.godot'), [
    'config_version=5',
    '',
    '[application]',
    'config/name="Tiny Quest"',
    'config/version="0.3.0"',
    'config/features=PackedStringArray("4.4", "GL Compatibility")',
    'run/main_scene="res://scenes/main.tscn"',
    '',
    '[rendering]',
    'renderer/rendering_method="gl_compatibility"',
  ].join('\n'))
  await writeFile(join(project, 'scenes', 'main.tscn'), '[gd_scene]\n')
  await writeFile(join(project, 'scripts', 'player.gd'), 'extends Node\n')
  await writeFile(join(project, 'addons', 'camera', 'plugin.gd'), 'extends EditorPlugin\n')
  await writeFile(join(project, '.godot', 'generated.gd'), 'invalid generated file\n')
  await writeFile(join(project, 'export_presets.cfg'), '[preset.0]\n')

  const service = new GodotService(async () => ({ stdout: '4.4.stable.official\n', stderr: '' }), '/opt/godot')
  const inspected = await service.inspect(workspace) as any
  assert.equal(inspected.engine.executable, '/opt/godot')
  assert.equal(inspected.selection_required, false)
  assert.equal(inspected.projects[0].path, 'game')
  assert.equal(inspected.projects[0].name, 'Tiny Quest')
  assert.equal(inspected.projects[0].version, '0.3.0')
  assert.equal(inspected.projects[0].config_version, 5)
  assert.deepEqual(inspected.projects[0].features, ['4.4', 'GL Compatibility'])
  assert.equal(inspected.projects[0].main_scene, 'res://scenes/main.tscn')
  assert.equal(inspected.projects[0].renderer, 'gl_compatibility')
  assert.deepEqual(inspected.projects[0].files.scenes, ['scenes/main.tscn'])
  assert.deepEqual(inspected.projects[0].files.scripts.sort(), ['addons/camera/plugin.gd', 'scripts/player.gd'])
  assert.deepEqual(inspected.projects[0].files.addons, ['addons/camera/plugin.gd'])
  assert.equal(inspected.projects[0].files.scripts.includes('.godot/generated.gd'), false)
  assert.equal(inspected.projects[0].has_export_presets, true)
})

test('Godot checks one explicit workspace script and imports in recovery mode', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'shun-godot-run-')), project = join(workspace, 'game')
  await mkdir(join(project, 'scripts'), { recursive: true })
  await writeFile(join(project, 'project.godot'), 'config_version=5\n')
  await writeFile(join(project, 'scripts', 'player.gd'), 'extends Node\n')
  const calls: Array<{ args: string[]; cwd?: string; timeoutMs?: number }> = []
  const runner: GodotCommandRunner = async (args, options) => {
    calls.push({ args, cwd: options?.cwd, timeoutMs: options?.timeoutMs })
    return { stdout: args.includes('--import') ? 'Import complete\n' : '', stderr: '' }
  }
  const service = new GodotService(runner, '/opt/godot')
  assert.equal((await service.checkScript(workspace, 'scripts/player.gd', 'game')).ok, true)
  assert.equal((await service.importProject(workspace, 'game')).ok, true)
  const canonicalProject = await realpath(project)
  assert.deepEqual(calls[0].args.slice(0, 6), ['--headless', '--no-header', '--path', canonicalProject, '--script', join(canonicalProject, 'scripts', 'player.gd')])
  assert.equal(calls[0].args.at(-1), '--check-only')
  assert.deepEqual(calls[1].args, ['--headless', '--no-header', '--path', canonicalProject, '--recovery-mode', '--import'])
  assert.equal(calls[1].timeoutMs, 5 * 60_000)
})

test('Godot project and script paths cannot escape the task workspace', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'shun-godot-safe-')), outside = await mkdtemp(join(tmpdir(), 'shun-godot-outside-'))
  await writeFile(join(outside, 'project.godot'), 'config_version=5\n')
  await writeFile(join(outside, 'outside.gd'), 'extends Node\n')
  await symlink(outside, join(workspace, 'linked-project'))
  const service = new GodotService(async () => ({ stdout: '', stderr: '' }))
  await assert.rejects(() => service.inspect(workspace, 'linked-project'), /escapes the task workspace/i)
})
