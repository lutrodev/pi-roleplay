import { blankWriterHistory, type WriterHistoryConfig, type WriterHistorySettings } from './writer-history.ts'
import initialCase from './writer-history-example.json'
import { defaultWriterDelivery } from './writer-delivery.ts'

/** Two writing conversations, with the topic and generated text left for the user to fill. */
export function exampleWriterHistory(): WriterHistoryConfig {
  return structuredClone(initialCase)
}

/** Original, editable terminal-delivery example; no imported preset code or claims of authorization. */
export function terminalWriterHistory(): WriterHistoryConfig {
  const delivery = defaultWriterDelivery()
  return { enabled: false, delivery, rounds: [
    { user: '$ cat chapter_01.txt\n章节资料：雨后的灯塔，一位旅人叩门。', text: '雨停了。旅人收起伞，轻轻敲响灯塔的门。' },
    { user: '$ cat chapter_02.txt\n章节资料：守灯人开门，邀请旅人进屋。', text: '门后亮起一盏灯。守灯人侧过身，为旅人让出通往炉火的路。' },
  ].map(({ user, text }) => ({ user, steps: [{ name: delivery.toolName, argumentsJson: JSON.stringify({ [delivery.fieldName]: text }, null, 2),
    resultJson: '{"received":true}', isError: false }], assistant: '本段内容已交付。' })) }
}

/** Populate only the untouched old default as an unsaved draft; never migrate saved content. */
export function writerHistoryEditorDraft(saved: WriterHistorySettings): WriterHistoryConfig {
  return saved.revision === 1 && JSON.stringify(saved.config) === JSON.stringify(blankWriterHistory())
    ? exampleWriterHistory() : structuredClone(saved.config)
}
