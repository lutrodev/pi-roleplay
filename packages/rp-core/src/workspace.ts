import { requireValue } from './errors.ts'

export type WorkspaceAccess = 'read-only' | 'read-write'
export interface WorkspaceTarget { directory: string; access: WorkspaceAccess; createIfMissing: boolean }
export interface WorkspaceBinding extends WorkspaceTarget { workspaceId: string | null }
export interface WorkspaceRecord { id: string; name: string; directory: string; access: WorkspaceAccess; revision: number; createdAt: string; updatedAt: string }

/** A relative container-volume path, never a host path or a symlink alias. */
export function workspaceDirectory(input: unknown): string {
  requireValue(typeof input === 'string' && input.length > 0 && input.length <= 1024 && !/[\\\u0000-\u001f\u007f]/.test(input)
    && input.split('/').length <= 12 && input.split('/').every(part => part.length > 0 && part.length <= 120 && part !== '.' && part !== '..' && part.trim() === part),
  'INVALID_WORKSPACE_DIRECTORY', '请选择工具容器内的相对目录，不能使用绝对路径、上级路径或控制字符。')
  return input
}
export function workspaceAccess(input: unknown): WorkspaceAccess {
  requireValue(input === 'read-only' || input === 'read-write', 'INVALID_WORKSPACE_ACCESS', '工作区权限应为只读或可写。')
  return input
}
export function workspaceName(input: unknown): string {
  requireValue(typeof input === 'string' && input.trim().length > 0 && input.trim().length <= 120 && !/[\u0000-\u001f\u007f]/.test(input), 'INVALID_WORKSPACE_NAME', '工作区名称需要 1 至 120 个字符，且不能含有控制字符。')
  return input.trim()
}
export function directoriesOverlap(a: string, b: string) { return a === b || a.startsWith(b + '/') || b.startsWith(a + '/') }
