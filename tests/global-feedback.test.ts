import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it } from 'vitest'
import { EntryState, WorkspaceConnectionNotice } from '../apps/web/src/components/app-states.tsx'
import { ErrorNotice } from '../apps/web/src/components/ui.tsx'
import { ApiError } from '../apps/web/src/lib/api.ts'
import { errorFeedback, isSessionExpired, stalePageModule } from '../apps/web/src/lib/error-feedback.ts'
import { setUiLanguage } from '../apps/web/src/lib/i18n.ts'

afterEach(() => setUiLanguage('zh'))

describe('global error recovery', () => {
  it.each([502, 503, 504])('explains HTTP %i outages and preserves the precise diagnostic', status => {
    const error = new ApiError(`请求失败（${status}），请稍后重试。`, 'HTTP_ERROR', status)
    const feedback = errorFeedback(error)
    expect(feedback.title).toBe('服务暂时不可用')
    expect(feedback.details).toContain(`HTTP ${status}`)
    expect(feedback.details).toContain(error.message)
    const html = renderToStaticMarkup(createElement(EntryState, { error, busy: false, retry: () => {} }))
    expect(html).toContain('重试连接')
    expect(html).toContain('<details')
    expect(html).not.toContain('<details open')
  })

  it('distinguishes a rejected password from an expired session', () => {
    const rejected = errorFeedback(new ApiError('密码不正确。', 'LOGIN_FAILED', 401))
    expect(rejected.title).toBe('未能登录')
    expect(rejected.message).toBe('密码不正确。')
    expect(errorFeedback(new ApiError('请先登录。', 'AUTH_REQUIRED', 401)).title).toBe('需要重新登录')
    expect(isSessionExpired(new ApiError('请先登录。', 'AUTH_REQUIRED', 401))).toBe(true)
    expect(isSessionExpired(new ApiError('无法连接', 'NETWORK_ERROR', 0))).toBe(false)
    expect(isSessionExpired(new ApiError('请求失败', 'HTTP_ERROR', 502))).toBe(false)
  })

  it('gives network and rate-limit failures distinct recovery guidance without claiming an action succeeded', () => {
    const network = errorFeedback(new ApiError('无法连接', 'NETWORK_ERROR', 0))
    expect(network.title).toBe('连接暂时中断')
    expect(network.message).toContain('检查网络')
    expect(network.message).not.toContain('已保存')
    const limited = errorFeedback(new ApiError('Too many requests', 'HTTP_ERROR', 429))
    expect(limited.title).toBe('请求暂时受限')
    expect(limited.details).toContain('HTTP 429')
  })

  it('keeps actionable permission and missing-resource reasons', () => {
    expect(errorFeedback(new ApiError('没有访问权限。', 'DENIED', 403)).details).toBe('没有访问权限。')
    expect(errorFeedback(new ApiError('资料已删除。', 'NOT_FOUND', 404)).details).toBe('资料已删除。')
  })

  it('keeps edits on a conflict and blocks repeated clicks while a retry is pending', () => {
    const html = renderToStaticMarkup(createElement(ErrorNotice, { error: new ApiError('配置已更新。', 'REVISION_CONFLICT', 409), retry: () => {}, retrying: true }))
    expect(html).toContain('当前编辑内容仍留在表单中')
    expect(html).toContain('正在重试…')
    expect(html).toMatch(/<button[^>]*disabled=""/)
  })

  it('renders setup and loading separately from failures', () => {
    const props = { busy: false, retry: () => {} }
    const setup = renderToStaticMarkup(createElement(EntryState, { ...props, configured: false }))
    expect(setup).toContain('完成首次设置')
    expect(setup).toContain('重新检查')
    const loading = renderToStaticMarkup(createElement(EntryState, { ...props, busy: true }))
    expect(loading).toContain('role="status"')
    expect(loading).not.toContain('role="alert"')
    expect(loading).not.toContain('<button')
  })

  it('escapes and folds long unexpected errors while keeping recovery available', () => {
    const raw = '<script>untrusted</script>' + 'x'.repeat(1200)
    const html = renderToStaticMarkup(createElement(ErrorNotice, { error: new Error(raw), retry: () => {} }))
    expect(html).toContain('&lt;script&gt;untrusted&lt;/script&gt;')
    expect(html).not.toContain('<script>')
    expect(html).toContain('x'.repeat(1200))
    expect(html).toContain('查看详细原因')
    expect(html).toContain('重试')
  })

  it('uses an inline recovery notice for a cached workspace and translates authored copy', () => {
    setUiLanguage('en')
    const html = renderToStaticMarkup(createElement(WorkspaceConnectionNotice, { error: new ApiError('502', 'HTTP_ERROR', 502), busy: false, retry: () => {} }))
    expect(html).toContain('Service temporarily unavailable')
    expect(html).toContain('unsaved edits are still here')
    expect(html).toContain('Retry connection')
    expect(html).not.toContain('<main')
  })

  it('requires document recovery for failed lazy modules but not ordinary render errors', () => {
    for (const message of ['Failed to fetch dynamically imported module', 'Importing a module script failed', 'Failed to load module script']) expect(stalePageModule(new Error(message))).toBe(true)
    const named = new Error('Chunk failed'); named.name = 'ChunkLoadError'
    expect(stalePageModule(named)).toBe(true)
    expect(stalePageModule(new Error('Component render failed'))).toBe(false)
  })
})
