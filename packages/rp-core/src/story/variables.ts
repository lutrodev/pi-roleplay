import { objectInput } from '../input.ts'
import { requireValue } from '../errors.ts'
import type { StoryProfile } from '../types.ts'

export interface VariableSettings { enabled: boolean; mvu: boolean }
export const DEFAULT_VARIABLE_SETTINGS: Readonly<VariableSettings> = { enabled: true, mvu: true }

export function normalizeVariableSettings(input: unknown): VariableSettings {
  if (input === undefined) return { ...DEFAULT_VARIABLE_SETTINGS }
  objectInput(input)
  requireValue(Object.keys(input).sort().join(',') === 'enabled,mvu' && typeof input.enabled === 'boolean' && typeof input.mvu === 'boolean',
    'INVALID_PROFILE', '会话变量设置需要启用状态和 MVU 兼容选项。')
  return { enabled: input.enabled, mvu: input.mvu }
}

/** Old event profiles predate these settings; their built-in defaults remain explicit here. */
export function storyVariables(profile: Pick<StoryProfile, 'variables'>): Readonly<VariableSettings> {
  return profile.variables ?? DEFAULT_VARIABLE_SETTINGS
}
