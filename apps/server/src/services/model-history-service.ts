import { projectModelHistory, type ModelHistoryEntry } from '../../../../packages/rp-core/src/story/model-history.ts'
import { projectStory } from '../../../../packages/rp-core/src/story/projection.ts'
import { requireValue } from '../../../../packages/rp-core/src/errors.ts'
import type { StorySnapshot } from '../../../../packages/rp-core/src/types.ts'
import type { StoryRepository } from '../storage/story-repository.ts'

/** All retained messages are derived from, or inherited into, the same story event log. */
export class ModelHistoryService {
  constructor(readonly stories: StoryRepository) {}

  read(story: StorySnapshot, currentRunId?: string, checkpoint = story.checkpoint) {
    const projection = projectModelHistory(this.stories.historyEvents(story.id), story, checkpoint, currentRunId)
    requireValue(projection.missingRuns.length === 0, 'MODEL_HISTORY_MISSING', '这段对话缺少原始模型历史，无法完整恢复工具调用。请恢复包含执行记录的备份。', 409)
    return projection.entries
  }

  /** Older branches copied only reading events. Recover their exact original prefix once, before use/deletion. */
  restoreBranch(storyId: string, visiting = new Set<string>()) {
    const story = this.stories.snapshot(storyId)
    const events = this.stories.historyEvents(storyId)
    if (!story.forkedFrom || events.some(event => event.type === 'history.inherited')) return
    requireValue(!visiting.has(storyId), 'MODEL_HISTORY_MISSING', '对话来源形成循环，无法恢复历史。', 409)
    visiting.add(storyId)
    const sourceId = story.forkedFrom.storyId
    requireValue(this.stories.exists(sourceId), 'MODEL_HISTORY_MISSING', '原对话已删除，旧分支未保存完整执行记录。请恢复包含原对话的备份。', 409)
    this.restoreBranch(sourceId, visiting)
    const creation = this.stories.eventsOfTypes(storyId, ['story.created'])[0]!
    const sourceEvents = this.stories.eventLog(sourceId)
    // Sequence numbers are global: a later edit of the source must not alter an older branch.
    const prefix = sourceEvents.filter(event => event.seq < creation.seq || event.type === 'history.inherited')
    const original = projectStory(prefix)
    const through = original.messages.findIndex(message => message.id === story.forkedFrom!.messageId)
    requireValue(through >= 0, 'MODEL_HISTORY_MISSING', '原对话中找不到这个分支的起点，请恢复完整备份。', 409)
    original.messages = original.messages.slice(0, through + 1)
    const inherited = projectModelHistory(prefix, original, null)
    requireValue(inherited.missingRuns.length === 0, 'MODEL_HISTORY_MISSING', '原对话的执行记录不完整，无法恢复这个分支的工具历史。', 409)
    this.inherit(storyId, sourceId, inherited.entries)
    visiting.delete(storyId)
  }

  inherit(storyId: string, sourceStoryId: string, entries: ModelHistoryEntry[]) {
    this.stories.append(storyId, { type: 'history.inherited', data: { version: 1, sourceStoryId, entries: structuredClone(entries) } }, 'native-history:inherited:v1')
  }
}
