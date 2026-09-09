import { ApiError } from './api-error.ts'

export interface ErrorFeedback { title: string; message?: string; help?: string; details?: string; icon: 'connection' | 'error' | 'locked' | 'clock' | 'missing' }

/** Explain the recoverable situation; preserve server diagnostics without making them the headline. */
export function errorFeedback(error: Error): ErrorFeedback {
  const message = error.message.trim()
  if (!(error instanceof ApiError)) return { title: '操作未完成', details: message, icon: 'error' }
  const diagnostic = [`HTTP ${error.status}${error.code === 'HTTP_ERROR' ? '' : ` · ${error.code}`}`, message].filter(Boolean).join('\n')
  if (error.code === 'LOGIN_FAILED') return { title: '未能登录', message, icon: 'locked' }
  if (error.code === 'INVALID_RESPONSE') return { title: '暂时无法读取内容', message: '服务器响应不完整，请重试。', details: diagnostic, icon: 'connection' }
  if (error.code === 'REVISION_CONFLICT') return { title: '内容已更新', message, help: '请刷新查看最新版本；当前编辑内容仍留在表单中。', icon: 'error' }
  if (error.status === 0) return { title: '连接暂时中断', message: '请检查网络连接，然后重试。', icon: 'connection' }
  if (error.status === 401) return { title: '需要重新登录', message: '登录状态已失效，请重新登录后继续。', icon: 'locked' }
  if (error.status === 429) return { title: '请求暂时受限', message: '请稍等片刻，再试一次。', details: diagnostic, icon: 'clock' }
  if (error.status >= 500) return { title: '服务暂时不可用', message: '服务暂时未能完成请求，请稍后重试。', details: diagnostic, icon: 'connection' }
  if (error.status === 404) return { title: '未找到请求的内容', details: message, icon: 'missing' }
  if (error.status === 403) return { title: '暂时无法执行此操作', details: message, icon: 'locked' }
  return { title: '操作未完成', details: message, icon: 'error' }
}

export function stalePageModule(error: Error) {
  return error.name === 'ChunkLoadError' || /dynamically imported module|Importing a module script failed|Failed to load module script/u.test(error.message)
}

export function isSessionExpired(error: Error | null | undefined) { return error instanceof ApiError && error.status === 401 }
