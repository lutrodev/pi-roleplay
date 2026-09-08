import { afterEach, describe, expect, it } from 'vitest'
import { StoryService } from '../apps/server/src/services/story-service.ts'
import { TurnService } from '../apps/server/src/services/turn-service.ts'
import { parseCharacterCardFile } from '../packages/rp-core/src/character/character-card.js'
import { fixture, message } from './helpers.ts'

const fixtures: ReturnType<typeof fixture>[] = []
afterEach(() => { for (const item of fixtures.splice(0)) item.close() })
function setup() { const item = fixture(); fixtures.push(item); return { ...item, service: new StoryService(item.stories, item.assets, item.files) } }

describe('story lifecycle', () => {
  it('creates a blank story with the default persona, preset and style bound', () => {
    const x = setup()
    const story = x.service.create('新故事')
    expect(story.messages).toEqual([])
    expect(story.profile.runtime.executionMode).toBe('chat')
    expect(story.profile.cast).toEqual([{ characterId: 'player', name: '用户角色', controller: 'user' }])
    expect(x.assets.get(story.profile.resources.preset!.id).name).toBe('示例预设')
    expect(story.profile.resources.writingStyles).toHaveLength(1)
  })

  it('materializes MVU initialization while displaying clean macro-expanded opening prose', () => {
    const x = setup()
    const parsed = parseCharacterCardFile(Buffer.from(JSON.stringify({ spec: 'chara_card_v3', data: {
      name: '守塔人', first_mes: '<initvar>{"energy":10}</initvar>你好，{{user}}。我是{{char}}。',
    } })), 'card.json', { maxTextCharacters: 2_000_000 })
    const { card } = x.assets.importCharacter(parsed)
    const persona = x.assets.create('persona', { name: '林澈' })
    const story = x.service.create('海岸', { scene: { openingSource: 'card', openingIndex: 0 }, resources: { card: { id: card.id }, persona: { id: persona.id }, lorebooks: [], writingStyles: [] } })
    expect(story.messages[0]?.text).toBe('你好，林澈。我是守塔人。')
    expect(story.state.namespaces.story?.value).toEqual({ energy: 10 })
    expect(story.messages[0]?.text).not.toContain('initvar')
  })

  it('keeps skip-opening empty even when a card contains MVU control-only text', () => {
    const x = setup()
    const parsed = parseCharacterCardFile(Buffer.from(JSON.stringify({ name: '角色', first_mes: '<initvar>{"energy":10}</initvar>' })), 'card.json', { maxTextCharacters: 2_000_000 })
    const { card } = x.assets.importCharacter(parsed)
    const story = x.service.create('跳过', { scene: { openingSource: 'skip' }, resources: { card: { id: card.id }, lorebooks: [], writingStyles: [] } })
    expect(story.messages).toEqual([])
  })

  it('preserves current user text and attachments when saving and regenerating, including retrying the request', () => {
    const x = setup()
    let story = x.service.create('重试')
    const attachmentIds = ['picture', 'document'].map(name => x.files.save(Buffer.from(name), name + '.txt', 'text/plain').id)
    const first = x.service.send(story.id, 'send-a', [{ text: '旧内容', attachmentIds }]).run
    x.stories.setRunStatus(first.id, 'running')
    x.stories.setRunStatus(first.id, 'failed', { code: 'TEST_FAILURE', message: '失败测试' })
    story = x.stories.snapshot(story.id)
    const user = story.messages.at(-1)!
    const replay = x.service.regenerate(story.id, story.revision, user.id, 'regenerate-a', '修改后的内容')
    expect(x.service.regenerate(story.id, story.revision, user.id, 'regenerate-a', '修改后的内容')).toEqual({ run: replay.run, duplicate: true })
    const result = x.stories.snapshot(story.id)
    expect(result.messages).toHaveLength(1)
    expect(result.messages[0]).toMatchObject({ text: '修改后的内容', attachmentIds, runId: replay.run.id })
    expect(() => x.service.edit(story.id, result.revision, result.messages[0]!.id, '执行中编辑')).toThrow('等待')
  })

  it('forks only visible history through the chosen message and keeps branches independent', () => {
    const x = setup()
    const story = x.service.create('原故事')
    const first = message('user', '第一条'), second = message('assistant', '第二条'), third = message('user', '第三条')
    for (const item of [first, second, third]) x.stories.append(story.id, { type: 'message.added', data: { message: item } })
    const current = x.stories.snapshot(story.id)
    x.service.edit(story.id, current.revision, first.id, '已编辑的第一条')
    const branch = x.service.fork(story.id, x.stories.snapshot(story.id).revision, second.id)
    expect(branch.id).not.toBe(story.id)
    expect(branch.messages.map(item => item.text)).toEqual(['已编辑的第一条', '第二条'])
    const child = x.service.fork(branch.id, branch.revision, first.id)
    expect([story.id, branch.id, child.id].map(id => x.stories.workspaceBinding(id).directory)).toEqual([story.id, story.id, story.id])
    x.service.remove(branch.id, branch.revision, second.id)
    expect(x.stories.snapshot(story.id).messages).toHaveLength(3)
    expect(x.stories.snapshot(branch.id).messages).toHaveLength(1)
  })

  it('invalidates a previous summary when its source text is edited', () => {
    const x = setup()
    const story = x.service.create('摘要')
    const user = message('user', '原来的事实')
    x.stories.append(story.id, { type: 'message.added', data: { message: user } })
    x.stories.append(story.id, { type: 'summary.created', data: { throughMessageId: user.id, sourceMessageIds: [user.id], text: '旧事实摘要' } })
    const current = x.stories.snapshot(story.id)
    expect(current.checkpoint?.text).toBe('旧事实摘要')
    x.service.edit(story.id, current.revision, user.id, '新的事实')
    expect(x.stories.snapshot(story.id).checkpoint).toBeNull()
  })
})
