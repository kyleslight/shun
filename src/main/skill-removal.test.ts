import assert from 'node:assert/strict'
import test from 'node:test'
import type { SkillState } from '../shared.ts'
import { planSkillRemoval } from './skill-removal.ts'

const local = (name: string): SkillState => ({
  id: `skill:${name}`, name, description: name, installed: true, enabled: true,
  origin: 'local', removable: true,
})

test('batch Skill removal plans user-installed local Skills and package installation units', () => {
  const packaged: SkillState = {
    id: 'skill:packaged-one', name: 'packaged-one', description: 'package', installed: true, enabled: true,
    origin: 'package', removable: true, packageSource: 'npm:skill-pack',
  }
  assert.deepEqual(planSkillRemoval(['local-one', 'skill:local-two', 'packaged-one'], [], [local('local-one'), local('local-two'), packaged]), {
    local: [local('local-one'), local('local-two')],
    packages: [{ source: 'npm:skill-pack', skills: ['packaged-one'] }],
  })
})

test('batch Skill removal protects first-party and externally managed Skills before mutation', () => {
  const firstParty: SkillState = {
    id: 'first-party', name: 'First party', description: 'bundled', installed: true, enabled: true,
    origin: 'plugin', removable: false,
  }
  assert.throws(() => planSkillRemoval(['First party'], [firstParty], [local('local-one')]), /First-party Skill is protected/)
  assert.throws(() => planSkillRemoval(['project-one'], [], [{ ...local('project-one'), origin: 'project', removable: false }]), /managed outside Shun/)
  assert.throws(() => planSkillRemoval(['missing'], [], [local('local-one')]), /Installed Skill not found/)
})
