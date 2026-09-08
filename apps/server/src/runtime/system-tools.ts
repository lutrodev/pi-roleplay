import { Type } from '@earendil-works/pi-ai'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import { RpError, requireValue } from '../../../../packages/rp-core/src/errors.ts'
import { DEFAULT_TOOL_SETTINGS, normalizeToolSettings, type ToolSettings } from '../../../../packages/rp-core/src/settings/tools.ts'
import type { JsonValue, RunRecord } from '../../../../packages/rp-core/src/types.ts'
import type { FileService } from '../services/file-service.ts'
import type { QuestionService } from '../services/question-service.ts'
import { imageMime, MAX_UPLOAD_BYTES } from '../storage/file-repository.ts'
import type { RuntimeToolScope } from './executor.ts'
import type { ToolClient } from './tool-client.ts'
import type { DeepSeekSearch } from './search.ts'
import { defineTool, runTool, toolResult } from './tool-result.ts'
import { RunJournal } from './journal.ts'

/** Tools use the internal service even when the web app itself is running directly on the developer's machine. */
export class SystemTools {
  readonly settings: ToolSettings
  constructor(readonly client: ToolClient, readonly files: FileService, readonly questions: QuestionService, readonly search: DeepSeekSearch, settings: ToolSettings = DEFAULT_TOOL_SETTINGS) {
    this.settings = normalizeToolSettings(settings)
  }

  readonlyFiles(run: RunRecord, signal: AbortSignal, images: boolean): AgentTool[] {
    const read = defineTool({ name: 'read', label: '读取文件',
      description: 'Read a UTF-8 file or list a directory. Relative paths start at the story workspace root, independently of Bash cwd. /inputs and /skills are read-only. offset is 1-based; output is limited to 2000 lines and 64 KB.',
      parameters: Type.Object({ file_path: Type.String({ minLength: 1, maxLength: 4096 }), offset: Type.Optional(Type.Integer({ minimum: 1 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 2000 })) }, { additionalProperties: false }),
      execute: async (_callId, input, toolSignal) => toolResult(async () => asJson(await this.client.execute(run.storyId,
        { kind: 'read', path: input.file_path, offset: input.offset, limit: input.limit }, { signal: together(signal, toolSignal) }))),
    })
    const readImage = defineTool({ name: 'read_image', label: '查看图片',
      description: 'Read an image from the story workspace, /inputs or /skills. The original file is saved as an immutable attachment for the tool record and supplied to this vision-capable model.',
      parameters: Type.Object({ file_path: Type.String({ minLength: 1, maxLength: 4096 }) }, { additionalProperties: false }),
      execute: async (_callId, input, toolSignal) => runTool(async () => {
        requireValue(images, 'MODEL_VISION_REQUIRED', '当前模型不支持查看图片。')
        const download = await this.client.execute(run.storyId, { kind: 'download', path: input.file_path }, { signal: together(signal, toolSignal) })
        requireValue(download && typeof download === 'object' && 'base64' in download && typeof download.base64 === 'string' && download.base64.length <= Math.ceil(MAX_UPLOAD_BYTES * 4 / 3) + 4 && 'name' in download && typeof download.name === 'string',
          'TOOL_PROTOCOL_ERROR', '图片下载结果不完整。', 502)
        const bytes = Buffer.from(download.base64, 'base64'), mimeType = imageMime(bytes)
        requireValue(mimeType, 'INVALID_IMAGE', '文件不是支持的 PNG、JPEG、WebP 或 GIF 图片。')
        const file = await this.files.captureImage(bytes, download.name)
        return { content: [{ type: 'text' as const, text: `Image: ${download.name} (fileId: ${file.id})` },
          { type: 'image' as const, data: bytes.toString('base64'), mimeType: file.mimeType }], details: { fileId: file.id, name: download.name, sourcePath: input.file_path, mimeType: file.mimeType } }
      }),
    })
    return images ? [read, readImage] : [read]
  }

  agent(scope: RuntimeToolScope, images: boolean): AgentTool[] {
    const { run, signal } = scope
    requireValue(this.files.stories.snapshot(run.storyId).profile.runtime.executionMode === 'agent', 'AGENT_MODE_REQUIRED', '这些工具仅在 Agent 模式可用。')
    const bash = defineTool({ name: 'bash', label: '运行 Bash',
      description: `Run a command in the story’s persistent Bash inside the tools container. The working directory, exports and functions persist across calls. Files persist across restarts. Timeout/cancellation resets shell state and kills ordinary child processes. Commands are limited to ${this.settings.commandTimeoutMs} ms; inline output is limited to ${this.settings.maxOutputBytes} UTF-8 bytes. When truncated, the result supplies a workspace path to the complete output file. /inputs and /skills are read-only. Filesystem tools resolve relative paths at the story root, not the current Bash directory.`,
      parameters: Type.Object({ command: Type.String({ minLength: 1, maxLength: 65536 }), timeout_ms: Type.Optional(Type.Integer({ minimum: 1, maximum: this.settings.commandTimeoutMs })), reset: Type.Optional(Type.Boolean()) }, { additionalProperties: false }),
      execute: async (_callId, input, toolSignal, update) => toolResult(async () => asJson(await this.client.execute(run.storyId, {
        kind: 'bash', command: input.command, timeoutMs: Math.min(input.timeout_ms ?? this.settings.commandTimeoutMs, this.settings.commandTimeoutMs), maxOutputBytes: this.settings.maxOutputBytes, reset: input.reset,
      }, { signal: together(signal, toolSignal), onOutput: text => update?.({ content: [{ type: 'text', text }], details: { outputDelta: text } }) }))),
    })
    const write = defineTool({ name: 'write', label: '写入文件',
      description: 'Create or overwrite a UTF-8 file atomically in the story workspace. content is the entire file, at most 1 MB. Parent directories must exist. /inputs and /skills are read-only. Use str_replace_editor undo_edit to undo the write if the file is unchanged.',
      parameters: Type.Object({ file_path: Type.String({ minLength: 1, maxLength: 4096 }), content: Type.String({ maxLength: 1048576 }) }, { additionalProperties: false }),
      execute: async (_callId, input, toolSignal) => toolResult(async () => asJson(await this.client.execute(run.storyId,
        { kind: 'edit', command: 'write', path: input.file_path, fileText: input.content }, { signal: together(signal, toolSignal) }))),
    })
    const edit = defineTool({ name: 'edit', label: '替换文件文本',
      description: 'Replace an exact literal string in a UTF-8 workspace file, at most 1 MB. old_string must be nonempty and match exactly once unless replace_all is true. An empty new_string deletes the match. /inputs and /skills are read-only.',
      parameters: Type.Object({ file_path: Type.String({ minLength: 1, maxLength: 4096 }), old_string: Type.String({ minLength: 1, maxLength: 1048576 }), new_string: Type.String({ maxLength: 1048576 }), replace_all: Type.Optional(Type.Boolean()) }, { additionalProperties: false }),
      execute: async (_callId, input, toolSignal) => toolResult(async () => asJson(await this.client.execute(run.storyId,
        { kind: 'edit', command: 'str_replace', path: input.file_path, oldText: input.old_string, newText: input.new_string, replaceAll: input.replace_all }, { signal: together(signal, toolSignal) }))),
    })
    const editor = defineTool({ name: 'str_replace_editor', label: '编辑文件',
      description: 'View, create, precisely replace, insert after a line, or undo a recent file edit. Relative paths start at the story root. create refuses existing files. str_replace requires exactly one match and omitted new_str deletes it. insert_line is 0 for before the first line, otherwise insertion follows that line. Undo refuses files modified by another operation. Editing is limited to 1 MB; view is capped at 2000 lines/64 KB. /inputs and /skills cannot be edited.',
      parameters: Type.Object({ command: Type.Union((['view', 'create', 'str_replace', 'insert', 'undo_edit'] as const).map(value => Type.Literal(value))), path: Type.String({ minLength: 1, maxLength: 4096 }),
        file_text: Type.Optional(Type.Union([Type.String({ maxLength: 1048576 }), Type.Null()])), old_str: Type.Optional(Type.Union([Type.String({ maxLength: 1048576 }), Type.Null()])),
        new_str: Type.Optional(Type.Union([Type.String({ maxLength: 1048576 }), Type.Null()])), insert_line: Type.Optional(Type.Union([Type.Integer({ minimum: 0 }), Type.Null()])),
        view_range: Type.Optional(Type.Union([Type.Tuple([Type.Integer({ minimum: 1 }), Type.Integer({ minimum: -1 })]), Type.Null()])),
      }, { additionalProperties: false }),
      execute: async (_callId, input, toolSignal) => toolResult(async () => {
        if (input.command === 'view') {
          const offset = input.view_range?.[0] ?? 1, end = input.view_range?.[1] ?? -1
          requireValue(end === -1 || end >= offset, 'INVALID_RANGE', '查看范围的结束行不能小于起始行。')
          return asJson(await this.client.execute(run.storyId, { kind: 'read', path: input.path, offset, limit: end === -1 ? 2000 : Math.min(2000, end - offset + 1) }, { signal: together(signal, toolSignal) }))
        }
        if (input.command === 'str_replace' && input.new_str === null) throw new RpError('INVALID_EDIT', '删除原文请省略 new_str 或提供空字符串。')
        return asJson(await this.client.execute(run.storyId, { kind: 'edit', command: input.command, path: input.path,
          fileText: input.file_text ?? undefined, oldText: input.old_str ?? undefined, newText: input.command === 'str_replace' ? input.new_str ?? '' : input.new_str ?? undefined, insertLine: input.insert_line ?? undefined,
        }, { signal: together(signal, toolSignal) }))
      }),
    })
    const ask = defineTool({ name: 'ask_user_question', label: '询问用户', description: 'Ask for a user decision or missing information. Use stable IDs. A batch may include single-choice, multi-choice and free-text questions; custom answers are always allowed. Waits for the actual user response, which remains visible after a page reload.',
      parameters: Type.Object({ questions: Type.Array(Type.Object({ id: Type.String({ minLength: 1, maxLength: 80 }), question: Type.String({ minLength: 1, maxLength: 4000 }), header: Type.Optional(Type.String({ minLength: 1, maxLength: 80 })),
        options: Type.Optional(Type.Array(Type.Object({ label: Type.String({ minLength: 1, maxLength: 160 }), description: Type.Optional(Type.String({ minLength: 1, maxLength: 1000 })) }, { additionalProperties: false }), { maxItems: 12 })),
        multi_select: Type.Optional(Type.Boolean()),
      }, { additionalProperties: false }), { minItems: 1, maxItems: 8 }) }, { additionalProperties: false }),
      execute: async (callId, input, toolSignal) => toolResult(async () => asJson(await this.questions.ask(run.id, callId,
        input.questions.map(question => { const { multi_select, ...item } = question; return { ...item, multiSelect: multi_select === true } }), together(signal, toolSignal)))),
    })
    const writable = this.client.workspace(run.storyId).access === 'read-write'
    return [...this.readonlyFiles(run, signal, images), ...(writable ? [bash, write, edit, editor] : []), this.webSearch(run, signal), ask]
  }

  webSearch(run: RunRecord, signal: AbortSignal, scope = 'main') {
    const journal = new RunJournal(this.files.stories, this.files.files, run)
    return defineTool({ name: 'web_search', label: '搜索网页', description: 'Search the web using the configured native search provider. Returns source URLs, titles and available citation excerpts. Results are external reference material. Missing native search results are an error, not a model-generated substitute.',
      parameters: Type.Object({ query: Type.String({ minLength: 1, maxLength: 2000 }), max_results: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })) }, { additionalProperties: false }),
      execute: async (callId, input, toolSignal) => toolResult(async () => asJson(await this.search.search(input.query, input.max_results ?? 5, together(signal, toolSignal),
        request => journal.model(journal.callId(callId, scope), 'search:request', request)))),
    })
  }
}

function together(signal: AbortSignal, other?: AbortSignal) { return other ? AbortSignal.any([signal, other]) : signal }
function asJson(value: unknown): JsonValue { return JSON.parse(JSON.stringify(value)) }
