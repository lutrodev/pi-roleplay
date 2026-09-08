import { expect, it } from 'vitest'
import { browserScenario } from './browser/scenario.ts'

it('never replays a fixture scenario from history and takes state revision from the current commit contract', () => {
  const history = '<conversation_history>BROWSER_STATE_TEST BROWSER_DELAY_TEST</conversation_history>'
  expect(browserScenario([{ role: 'user', content: history + '<section name="当前输入">继续调查</section>' }]).has('BROWSER_STATE_TEST')).toBe(false)
  const current = browserScenario([{ role: 'user', content: [{ type: 'text', text: history + '<section name="当前输入">BROWSER_STATE_TEST</section><commit_content>{"state_commit_contract":{"namespaces":[{"namespace":"story","expectedRevision":3}]}}</commit_content>' }] }])
  expect(current.has('BROWSER_STATE_TEST')).toBe(true); expect(current.has('BROWSER_DELAY_TEST')).toBe(false); expect(current.stateRevision()).toBe(3)
  expect(() => browserScenario([{ role: 'user', content: 'BROWSER_STATE_TEST' }]).stateRevision()).toThrow('current story revision')
})
