import type { SkillState } from '../shared.ts'

export type SkillRemovalPlan = {
  local: SkillState[]
  packages: Array<{ source: string; skills: string[] }>
}

export function planSkillRemoval(selectors: string[], protectedSkills: SkillState[], installed: SkillState[]): SkillRemovalPlan {
  const plannedLocal = new Map<string, SkillState>()
  const plannedPackages = new Map<string, string[]>()

  for (const value of selectors) {
    const selector = String(value || '').trim()
    if (!selector) throw Error('Skill name is required.')
    const normalized = selector.replace(/^skill:/i, '').toLowerCase()
    const protectedSkill = protectedSkills.find(skill => skill.id.toLowerCase() === selector.toLowerCase() || skill.name.toLowerCase() === normalized)
    if (protectedSkill) throw Error(`First-party Skill is protected and cannot be removed: ${protectedSkill.name}`)
    const skill = installed.find(candidate => candidate.id.toLowerCase() === selector.toLowerCase() || candidate.name.toLowerCase() === normalized)
    if (!skill) throw Error(`Installed Skill not found: ${selector}`)
    if (!skill.removable || (skill.origin !== 'local' && skill.origin !== 'package')) {
      throw Error(`Skill is managed outside Shun and cannot be removed here: ${skill.name}`)
    }
    if (skill.origin === 'package') {
      if (!skill.packageSource) throw Error(`Package source is unavailable for Skill: ${skill.name}`)
      const names = plannedPackages.get(skill.packageSource) || []
      if (!names.includes(skill.name)) plannedPackages.set(skill.packageSource, [...names, skill.name])
    } else {
      plannedLocal.set(skill.id, skill)
    }
  }

  return {
    local: [...plannedLocal.values()],
    packages: [...plannedPackages].map(([source, skills]) => ({ source, skills })),
  }
}
