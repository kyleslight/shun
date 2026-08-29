import { join } from 'node:path'
import { loadSkillsFromDir, type Skill } from '@earendil-works/pi-coding-agent'

const firstPartySkillNames = new Set(['shun-plugin-development'])

export function loadFirstPartySkills(appRoot: string, selectedSkillIds?: string[]): Skill[] {
  const selected = selectedSkillIds ? new Set(selectedSkillIds.map(id => id.toLowerCase())) : undefined
  return loadSkillsFromDir({ dir: join(appRoot, 'skills'), source: 'product-plugin' }).skills.filter(skill =>
    firstPartySkillNames.has(skill.name)
    && (!selected || selected.has(skill.name.toLowerCase()) || selected.has(`skill:${skill.name.toLowerCase()}`)),
  )
}
