import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { api, ApiError } from '../apps/web/src/lib/api.ts'
import { errorFeedback } from '../apps/web/src/lib/error-feedback.ts'
import { fieldValidationMessage } from '../apps/web/src/lib/field-validation.ts'
import { setUiLanguage } from '../apps/web/src/lib/i18n.ts'
import { ImportFeedback, importSummary, type ImportBatch } from '../apps/web/src/pages/library/import-feedback.tsx'

afterEach(() => { vi.unstubAllGlobals(); setUiLanguage('zh') })

describe('UI boundary recovery', () => {
  it.each(['<html>proxy returned a page</html>', '', 'null'])('rejects an unreadable successful response instead of leaving the page loading: %s', async body => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(body, { status: 200 })))
    const error = await api('/auth/status').catch(error => error)
    expect(error).toBeInstanceOf(ApiError)
    if (!(error instanceof ApiError)) throw new Error('Expected a recoverable API failure')
    expect(error.code).toBe('INVALID_RESPONSE')
    expect(errorFeedback(error).title).toBe('暂时无法读取内容')
    expect(errorFeedback(error).details).toContain('HTTP 200')
  })

  it('retains legitimate no-content responses and cancellation semantics', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 204 })))
    expect(await api('/assets/test', 'DELETE')).toBeUndefined()
    const controller = new AbortController(); controller.abort()
    const abort = new DOMException('Aborted', 'AbortError')
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(abort))
    await expect(api('/settings', 'GET', undefined, controller.signal)).rejects.toBe(abort)
  })

  it('retains the actual status of a non-JSON error response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('Bad gateway', { status: 502 })))
    await expect(api('/settings')).rejects.toMatchObject({ code: 'HTTP_ERROR', status: 502 })
  })

  it('explains native constraints without replacing their validation rules', () => {
    const validity = (flag: keyof ValidityState) => ({ [flag]: true } as unknown as ValidityState)
    expect(fieldValidationMessage(validity('valueMissing'), {})).toBe('请填写这一项。')
    expect(fieldValidationMessage(validity('rangeUnderflow'), { min: '1' })).toBe('不能小于 1。')
    expect(fieldValidationMessage(validity('rangeOverflow'), { max: '8' })).toBe('不能大于 8。')
    expect(fieldValidationMessage(validity('typeMismatch'), { type: 'url' })).toContain('https://example.com')
    expect(fieldValidationMessage(validity('customError'), { validationMessage: '请输入 JSON 对象。' })).toBe('请输入 JSON 对象。')
    expect(fieldValidationMessage(validity('valid'), {})).toBe('')
    setUiLanguage('en')
    expect(fieldValidationMessage(validity('valueMissing'), {})).toBe('Please fill in this field.')
  })

  it('distinguishes partial imports from success and retains actionable duplicates', () => {
    const batch: ImportBatch = { kind: 'character', total: 3, current: '', outcomes: [
      { name: 'new.json', status: 'success', message: '导入成功', id: 'new' },
      { name: 'existing.json', status: 'duplicate', message: '资料已存在', id: 'existing' },
      { name: 'broken.json', status: 'failed', message: '无法读取 JSON' },
    ] }
    expect(importSummary(batch)).toEqual({ completed: 3, success: 1, duplicate: 1, failed: 1 })
    const html = renderToStaticMarkup(createElement(ImportFeedback, { batch, busy: false, hide: () => {}, open: () => {}, refreshError: null, retry: () => {}, retrying: false }))
    expect(html).toContain('部分资料未能导入')
    expect(html).toContain('成功 1，重复 1，失败 1')
    expect(html.match(/>打开资料</g)).toHaveLength(2)
    expect(html).toContain('aria-valuenow="3"')
    expect(html).toContain('无法读取 JSON')
  })
})
