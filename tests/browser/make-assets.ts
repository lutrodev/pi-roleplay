/** Original, synthetic fixtures for manual browser import/export and attachment verification. */
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import sharp from 'sharp'
import { encodeCharacterCardV3Png } from '../../packages/rp-core/src/character/character-card.js'

const directory = resolve('output/playwright/fixtures')
await mkdir(directory, { recursive: true })
const card = { spec: 'chara_card_v3', spec_version: '3.0', data: {
  name: '江栖', description: '雾港码头的修船匠，擅长从细小的痕迹寻找线索。', personality: '耐心，直率。', scenario: '雨后的旧码头。',
  first_mes: '江栖放下手里的工具，指了指岸边的旧木船。', alternate_greetings: ['木船静静停在码头，江栖递来一张海图。'],
  creator_notes: '本项目原创浏览器验收资料。', tags: ['原创验收'], system_prompt: '使用第二人称叙事，保留用户角色的决定权。',
  character_book: { name: '雾港码头', entries: [{ id: 'harbor', keys: ['码头'], content: '码头最东侧有一家只在黄昏开门的修船铺。', enabled: true }] },
} }
const avatar = await sharp({ create: { width: 96, height: 96, channels: 3, background: '#48705c' } }).png().toBuffer()
await writeFile(resolve(directory, 'harbor-card.json'), JSON.stringify(card, null, 2))
await writeFile(resolve(directory, 'harbor-card.png'), Buffer.from(encodeCharacterCardV3Png({ ...card, data: { ...card.data, name: '江栖·PNG 验收' } }, avatar)))
await writeFile(resolve(directory, 'avatar.png'), avatar)
await writeFile(resolve(directory, 'notes.txt'), '原始附件：灯塔与码头之间有一条石板路。\n')
await writeFile(resolve(directory, 'mvu-card.json'), JSON.stringify({ spec: 'chara_card_v3', spec_version: '3.0', data: {
  name: '小舟·MVU 验收', description: '本项目原创变量初始化验收角色。', first_mes: '<initvar>{"energy":10,"weather":"晴"}</initvar>你好，{{user}}。我是{{char}}。',
} }, null, 2))
process.stdout.write(directory + '\n')
