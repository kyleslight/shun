import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import test from 'node:test'
import { loadFirstPartySkills } from './product-skills.ts'

const root = resolve(import.meta.dirname, '../..')

test('the first-party plugin development Skill is loaded from an explicit product root', async () => {
  const skills = loadFirstPartySkills(root)
  const development = skills.find(skill => skill.name === 'shun-plugin-development')
  assert.ok(development)
  assert.match(development.description, /Shun plugin/i)
  assert.match(development.filePath, /skills[/\\]shun-plugin-development[/\\]SKILL\.md$/)
  assert.equal(loadFirstPartySkills(root, ['skill:unrelated']).length, 0)
  assert.equal(loadFirstPartySkills(root, ['skill:shun-plugin-development']).length, 1)

  const body = await readFile(development.filePath, 'utf8')
  assert.match(body, /plugin_package/)
  assert.match(body, /action=scaffold/)
  assert.match(body, /plugin_view_test/)
  assert.match(body, /Do not inspect application source, installed copies, templates, validators, or unrelated plugins/i)
  assert.doesNotMatch(body, /golden sample/i)
  assert.doesNotMatch(body, /resources\/plugins\/git-workbench/)
  assert.ok(body.split('\n').length < 60, 'the primary creation manual should stay concise')
  assert.doesNotMatch(body, /PDF|CJK|canvas/i)
})

test('the production package includes the complete first-party plugin development Skill', async () => {
  const manifest = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'))
  assert.ok(manifest.build.files.includes('skills/shun-plugin-development/**/*'))
})
