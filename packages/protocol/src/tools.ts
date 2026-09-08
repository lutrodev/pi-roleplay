export type FileCommand =
  | { kind: 'read'; path: string; offset?: number; limit?: number }
  | { kind: 'list'; path?: string }
  | { kind: 'download'; path: string }
  | { kind: 'edit'; command: 'create' | 'write' | 'str_replace' | 'insert' | 'undo_edit'; path: string; fileText?: string; oldText?: string; newText?: string; insertLine?: number; replaceAll?: boolean }
export type ToolCommand = FileCommand | { kind: 'bash'; command: string; timeoutMs?: number; maxOutputBytes?: number; reset?: boolean }
import type { WorkspaceTarget } from '../../rp-core/src/workspace.ts'
export interface ToolRequest { id: string; storyId: string; workspace: WorkspaceTarget; command: ToolCommand }
export type ToolWireEvent =
  | { type: 'output'; text: string }
  | { type: 'result'; value: unknown }
  | { type: 'error'; code: string; message: string; details?: unknown }
export interface ShellResult { output: string; exitCode: number; truncated: boolean; shellState: 'new' | 'retained'; outputFile?: string; outputBytes: number }

const uuid = { type: 'string', pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' }
const path = { type: 'string', minLength: 1, maxLength: 4096 }
export const toolIdParamsSchema = { type: 'object', additionalProperties: false, required: ['id'], properties: { id: uuid } }
export const toolRequestSchema = {
  type: 'object', additionalProperties: false, required: ['id', 'storyId', 'workspace', 'command'],
  properties: { id: uuid, storyId: uuid, workspace: { type: 'object', additionalProperties: false, required: ['directory', 'access', 'createIfMissing'], properties: {
    directory: { type: 'string', minLength: 1, maxLength: 1024 }, access: { enum: ['read-only', 'read-write'] }, createIfMissing: { type: 'boolean' },
  } }, command: { anyOf: [
    { type: 'object', additionalProperties: false, required: ['kind', 'command'], properties: {
      kind: { const: 'bash' }, command: { type: 'string', minLength: 1, maxLength: 65536 }, timeoutMs: { type: 'integer', minimum: 1, maximum: 300000 }, maxOutputBytes: { type: 'integer', minimum: 1, maximum: 1048576 }, reset: { type: 'boolean' },
    } },
    { type: 'object', additionalProperties: false, required: ['kind', 'path'], properties: {
      kind: { const: 'read' }, path, offset: { type: 'integer', minimum: 1 }, limit: { type: 'integer', minimum: 1, maximum: 2000 },
    } },
    { type: 'object', additionalProperties: false, required: ['kind'], properties: { kind: { const: 'list' }, path } },
    { type: 'object', additionalProperties: false, required: ['kind', 'path'], properties: { kind: { const: 'download' }, path } },
    { type: 'object', additionalProperties: false, required: ['kind', 'command', 'path'], properties: {
      kind: { const: 'edit' }, command: { enum: ['create', 'write', 'str_replace', 'insert', 'undo_edit'] }, path, replaceAll: { type: 'boolean' },
      fileText: { type: 'string', maxLength: 1048576 }, oldText: { type: 'string', maxLength: 1048576 }, newText: { type: 'string', maxLength: 1048576 }, insertLine: { type: 'integer', minimum: 0 },
    } },
  ] } },
}
