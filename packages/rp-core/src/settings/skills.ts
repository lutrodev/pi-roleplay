export function disabledSkillNames(disabledSkills: readonly string[], stateEnabled = true) {
  return [...new Set([...disabledSkills, ...(!stateEnabled ? ['rp-guide-state'] : []),
    ...(disabledSkills.includes('rp-guide-preset') ? ['rp-guide-preset-sillytavern'] : [])])]
}
