import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import type { TrajectoryEntry } from '../packages/protocol/src/trace.ts'
import { HistoryDetail, RequestMessages } from '../apps/web/src/pages/story/trajectory/history.tsx'
import { isError } from '../apps/web/src/pages/story/trajectory/model.ts'

const call = '{"role":"assistant","content":[{"type":"toolCall","id":"wh_r1_s1","name":"read_log","arguments":{"entry":900719925474099312345}}]}'
const result = JSON.stringify({ role: 'toolResult', toolCallId: 'wh_r1_s1', toolName: 'read_log', isError: true, content: [{ type: 'text', text: '{"entry":900719925474099312345,"note":"**literal JSON**"}' }] })
const input = { historyMessagesJson: [call, result], messages: [JSON.parse(call), JSON.parse(result), { role: 'user', content: [{ type: 'text', text: '真实当前输入' }] }], writerHistory: { revision: 2, digest: 'test', messageCount: 2, toolCallCount: 1 } }
const entry: TrajectoryEntry = { id: 'history:request:1', seq: 1, kind: 'tool', agentId: 'writer', title: 'read_log', preview: '', startedAt: new Date(0).toISOString(), status: 'failed', history: { round: 1 }, detail: { type: 'request', requestId: 'request', messageIndex: 1 } }

it('renders original arguments and literal results instead of rounded JSON or live model output', () => {
  const html = renderToStaticMarkup(createElement(HistoryDetail, { entry, input, tab: 'overview' }))
  expect(html).toContain('900719925474099312345')
  expect(html).not.toContain('900719925474099300000')
  expect(html).toContain('**literal JSON**')
  expect(html).toContain('isError: true')
  expect(html).not.toContain('真实当前输入')
  expect(isError(entry)).toBe(false)
  expect(isError({ status: 'failed' })).toBe(true)
})

it('uses lossless source in full request details while preserving the real current input', () => {
  const html = renderToStaticMarkup(createElement(RequestMessages, { input }))
  expect(html).toContain('900719925474099312345')
  expect(html).not.toContain('900719925474099300000')
  expect(html).toContain('真实当前输入')
})
