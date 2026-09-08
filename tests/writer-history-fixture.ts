import type { WriterHistoryConfig } from '../packages/rp-core/src/agents/writer-history.ts'

/** Authored benign fixture, never installed as user configuration. */
export function historyConfig(): WriterHistoryConfig {
  return { enabled: true, rounds: [{ user: '查阅灯塔值班记录。', steps: [
    { name: 'read_log', argumentsJson: '{"date":"Monday"}', resultJson: '{"ok":false,"reason":"date_required_iso"}', isError: true },
    { name: 'read_log', argumentsJson: '{"date":"2026-09-07","entry":900719925474099312345,"scale":1.000000000000000001,"nested":{"n":1e400}}', resultJson: '{"ok":true,"entry":900719925474099312345}', isError: false },
  ], assistant: '日期修正后已读取记录。' },
    { user: '确认可以查阅公开记录。', steps: [{ name: 'check_access', argumentsJson: '{"scope":"public_log"}', resultJson: '{"ok":true,"scope":"public_log"}', isError: false }], assistant: '可以开始核对公开记录。' },
  ] }
}

export function historyTextResponse(text = '灯塔的门缓缓打开。') {
  return new Response('data: ' + JSON.stringify({ id: 'writer-response', choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
}
