import { createHash } from 'node:crypto'
import type { AgentEvent } from '@earendil-works/pi-agent-core'
import { requireValue } from '../../../../packages/rp-core/src/errors.ts'
import type { JsonObject, JsonValue, RunRecord } from '../../../../packages/rp-core/src/types.ts'
import { FileRepository, IMAGE_MIMES, MAX_UPLOAD_BYTES } from '../storage/file-repository.ts'
import type { StoryRepository } from '../storage/story-repository.ts'

/** Diagnostic records use immutable file references; Pi still receives the original image blocks. */
export class RunJournal {
  constructor(readonly stories: StoryRepository, readonly files: FileRepository, readonly run: RunRecord) {}
  callId(callId: string, scope = 'main') { return `${this.run.id}:${scope}:${callId}` }

  archive(value: unknown): JsonObject {
    const visit = (part: JsonValue): JsonValue => {
      if (Array.isArray(part)) return part.map(visit)
      if (!isObject(part)) return part
      if (part.type !== 'image' || typeof part.data !== 'string' || typeof part.mimeType !== 'string') return Object.fromEntries(Object.entries(part).map(([key, value]) => [key, visit(value)]))
      requireValue(IMAGE_MIMES.has(part.mimeType) && part.data.length <= Math.ceil(MAX_UPLOAD_BYTES * 4 / 3) + 4, 'MODEL_IMAGE_INVALID', '模型记录包含不支持或过大的图片。')
      const bytes = Buffer.from(part.data, 'base64'), digest = createHash('sha256').update(bytes).digest('hex')
      let file = this.files.findImage(digest, part.mimeType)
      if (file) this.files.read(file.id)
      else file = this.files.save(bytes, 'model-image.' + part.mimeType.split('/')[1], part.mimeType)
      return { type: 'image_reference', fileId: file.id, mimeType: file.mimeType }
    }
    return visit(JSON.parse(JSON.stringify(value ?? {})) as JsonValue) as JsonObject
  }

  model(ownerMessageId: string, role: string, message: unknown) {
    this.stories.append(this.run.storyId, { type: 'model.message', data: {
      runId: this.run.id, ownerMessageId, role, message: this.archive(message),
    } })
  }

  tool(event: AgentEvent, scope = 'main', parentCallId?: string) {
    if (event.type === 'tool_execution_start') this.stories.append(this.run.storyId, { type: 'tool.started', data: {
      callId: this.callId(event.toolCallId, scope), runId: this.run.id, ...(parentCallId ? { parentCallId } : {}),
      name: event.toolName, arguments: this.archive(event.args), status: 'running',
    } })
    if (event.type === 'tool_execution_update') {
      const partial = this.archive(event.partialResult)
      const output = isObject(partial.details) && typeof partial.details.outputDelta === 'string' ? partial.details.outputDelta : JSON.stringify(partial)
      this.stories.append(this.run.storyId, { type: 'tool.updated', data: { callId: this.callId(event.toolCallId, scope), output } })
    }
    if (event.type === 'tool_execution_end') this.stories.append(this.run.storyId, { type: 'tool.finished', data: {
      callId: this.callId(event.toolCallId, scope), result: this.archive(event.result), failed: event.isError,
    } })
  }
}
function isObject(value: JsonValue | undefined): value is JsonObject { return value !== null && typeof value === 'object' && !Array.isArray(value) }
