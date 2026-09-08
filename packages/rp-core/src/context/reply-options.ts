import { replyOptionsGuidance } from '../interaction/reply-options.js'
import type { Preferences } from '../settings/preferences.ts'

/** Main-model guidance only; Writer and task subagents do not generate choices. */
export function replyOptionsInstructions(config?: Preferences['replyOptions']) {
  if (!config) return 'Reply options are disabled. Omit extensions from rp_commit_turn, or use extensions:{}.'
  return [
    'Generate reply options in the same rp_commit_turn call as the narrative effects. Use the final prose you are committing and the resulting story state, not an earlier draft. Do not call another model or tool to generate options.',
    'Return extensions:{"rp.reply-options":{"options":["next message", "another choice"]}}. These are suggestions for a future user turn; they have not happened, so do not apply their events to the current effects or summary.',
    `Generate exactly ${config.count} distinct, directly sendable roleplay continuations, each within ${config.maxCharacters} Unicode characters.`,
    replyOptionsGuidance(config.keywords),
    'If no usable options can be produced, omit this extension. Options are advisory: never retry a successful narrative commit just to repair or add them. Non-narrative replies through rp_reply do not need options.',
  ].join('\n')
}
