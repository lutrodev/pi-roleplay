import type { Page, Request } from '@playwright/test'

/** Playwright CLI regression against an authenticated, isolated browser fixture story. */
export default async (page: Page) => {
  const origin = page.url().split('/stories/')[0]!, storyId = page.url().split('/stories/')[1]!.split('?')[0]!
  const path = `/api/stories/${storyId}`, results: object[] = []
  const assert = (condition: unknown, message: string) => { if (!condition) throw new Error(message) }
  const get = async (url: string) => (await page.request.get(origin + url)).json()
  const input = page.getByRole('textbox', { name: '输入消息', exact: true })
  const send = page.getByRole('button', { name: '发送消息', exact: true })
  const radio = (mode: string) => page.getByRole('radio', { name: mode === 'agent' ? 'Agent' : 'Chat', exact: true })
  const submissionRequests: Request[] = []
  const watch = (request: Request) => {
    if (request.method() === 'POST' && ['/messages', '/input-queue', '/summaries'].some(suffix => request.url().endsWith(path + suffix))) submissionRequests.push(request)
  }
  page.on('request', watch)
  const waitReady = async (mode: string) => {
    for (let i = 0; i < 100; i++) {
      if (await radio(mode).isChecked() && await radio(mode).isEnabled()) return
      await page.waitForTimeout(100)
    }
    throw new Error('Composer did not unlock with the saved mode')
  }
  const waitRun = async (id: string) => {
    for (let i = 0; i < 100; i++) {
      const { run } = await get(`/api/runs/${id}`)
      if (!['queued', 'running', 'waiting_user'].includes(run.status)) {
        assert(run.status === 'completed', JSON.stringify(run)); return run
      }
      await page.waitForTimeout(200)
    }
    throw new Error('Run did not complete')
  }
  try {
    const initial = await get(path), originalHistory = initial.story.messages.find((item: { role: string }) => item.role === 'user')?.text
    for (const mode of ['agent', 'chat']) {
      const before = await get(path), oldMode = before.story.profile.runtime.executionMode
      assert(oldMode !== mode, 'Fixture must start in Chat mode')
      const draft = `模式保存竞争回归 ${oldMode}→${mode}，继续灯塔剧情。`
      await input.fill(draft)
      let release!: () => void, intercepted!: () => void
      const gate = new Promise<void>(resolve => { release = resolve }), started = new Promise<void>(resolve => { intercepted = resolve })
      const pattern = `**${path}/profile`
      await page.route(pattern, async route => { intercepted(); await gate; await route.continue() })
      const saved = page.waitForResponse(response => response.url().endsWith(path + '/profile') && response.request().method() === 'PUT')
      const startCount = submissionRequests.length
      try {
        // Same JavaScript task: the synchronous lock must also protect a stale submit handler before React rerenders.
        await radio(mode).evaluate(element => { (element as HTMLElement).click(); element.closest('form')!.requestSubmit() })
        await started
        assert(await send.isDisabled(), 'Send remained enabled while saving the mode')
        assert(await radio(oldMode).isDisabled(), 'Mode controls remained enabled while saving')
        await input.press('Enter'); await input.press('Control+Enter'); await input.press('Meta+Enter')
        await input.evaluate(element => element.closest('form')!.requestSubmit())
        assert(submissionRequests.length === startCount, 'A button, keyboard, or form submission escaped the save lock')
        assert(await input.inputValue() === draft, 'Saving mode consumed the draft')
        assert((await get(path)).runs.length === before.runs.length, 'A run started before the mode was saved')
        await page.screenshot({ path: `output/playwright/mode-switch-fix/saving-${oldMode}-to-${mode}.png` })
      } finally { release() }
      assert((await saved).status() === 200, 'Mode save failed')
      await page.unroute(pattern)
      await waitReady(mode)
      assert(await input.inputValue() === draft, 'Successful mode save changed the input')
      const sent = page.waitForResponse(response => response.url().endsWith(path + '/messages') && response.request().method() === 'POST')
      if (mode === 'agent') await send.click(); else await input.press('Enter')
      const response = await sent
      assert(response.status() === 202, await response.text())
      const runId = (await response.json()).run.id
      await waitRun(runId); await waitReady(mode)
      const { contexts } = await get(`/api/runs/${runId}/context`), context = contexts[0].data
      assert(context.parentPrompt.includes(`<roleplay_request mode="${mode}">`), 'Next turn used the old mode')
      assert(!originalHistory || context.writerPrompt.includes(originalHistory), 'Next turn lost prior conversation history')
      assert(submissionRequests.length === startCount + 1, 'Submission was duplicated')
      results.push({ case: `${oldMode}→${mode}`, status: 'passed', blockedDuringSave: true, sameTaskSubmitBlocked: true, keyboardBlocked: true, oneRun: runId, contextMode: mode, historyPreserved: true })
    }

    const beforeFailure = await get(path), failDraft = '保存失败时应保留的输入与重试内容。'
    await input.fill(failDraft)
    const pattern = `**${path}/profile`, beforeFailureCount = submissionRequests.length
    await page.route(pattern, route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'AUDIT_SAVE_FAILED', message: '模式保存测试失败，请重试。' } }) }))
    await radio('agent').click()
    const failure = page.getByRole('region', { name: '服务暂时不可用', exact: true })
    await failure.waitFor()
    await failure.getByText('查看详细原因', { exact: true }).click()
    assert((await failure.innerText()).includes('AUDIT_SAVE_FAILED'), 'Save error diagnostics were not retained')
    assert(await input.inputValue() === failDraft, 'Failed mode save lost input')
    assert(await radio('chat').isChecked() && await radio('agent').isEnabled(), 'Failed save did not retain the original mode and allow retry')
    assert((await get(path)).runs.length === beforeFailure.runs.length && submissionRequests.length === beforeFailureCount, 'Failed mode save created a run')
    await page.screenshot({ path: 'output/playwright/mode-switch-fix/save-failed.png' })
    await page.unroute(pattern)
    const retried = page.waitForResponse(response => response.url().endsWith(path + '/profile') && response.request().method() === 'PUT')
    await radio('agent').click(); assert((await retried).status() === 200, 'Save retry failed')
    await waitReady('agent')
    assert(await input.inputValue() === failDraft, 'Retry changed the draft')
    assert(await failure.count() === 0, 'Recovered save retained the error')
    results.push({ case: 'save failure and retry', status: 'passed', draftPreserved: true, noRunsOnFailure: true })
    await page.reload(); await radio('agent').waitFor(); await waitReady('agent')
    assert(await input.inputValue() === failDraft, 'Page reload lost the draft')
    results.push({ case: 'reload after save', status: 'passed', mode: 'agent', draftPreserved: true })
    return { status: 'passed', storyId, results }
  } finally { page.off('request', watch); await page.unrouteAll({ behavior: 'wait' }) }
}
