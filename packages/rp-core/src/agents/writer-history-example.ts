import { blankWriterHistory, type WriterHistoryConfig, type WriterHistorySettings } from './writer-history.ts'
import initialCase from './writer-history-example.json'
import { terminalWriterDelivery } from './writer-delivery.ts'

/** Two writing conversations, with the topic and generated text left for the user to fill. */
export function exampleWriterHistory(): WriterHistoryConfig {
  return structuredClone(initialCase)
}

/** Original, editable terminal-delivery example; no imported preset code or claims of authorization. */
export function terminalWriterHistory(): WriterHistoryConfig {
  const delivery = terminalWriterDelivery()
  return { enabled: false, delivery, rounds: [
    { user: '山城的旧电台即将重新开播。维修员许岚推开录音室的门，发现桌上多了一封没有署名的信。接着写。',
      check: '许岚在录音室门口；信尚未拆开；电台准备试播。',
      text: '许岚将工具箱放在门边。信封压着一张旧节目单，纸角恰好遮住了今晚试播的时间。她抬头望向控制室，隔音玻璃后，一盏本该熄灭的指示灯正在缓慢闪烁。' },
    { user: '她拆开信，里面只有一句“请在九点前调到旧频率”。让控制室里的同事作出反应。',
      check: '许岚已读信；同事位于控制室；还未切换频率。',
      text: '“先别碰旋钮。”控制室的扬声器忽然传出同事的声音。许岚举起信纸，他却没有看她，目光停在那块落灰的频率表上。“这个频段，停了十七年。”' },
  ].map(({ user, check, text }) => {
    const display = `user@linux:~$ cd Documents\nuser@linux:~/Documents$ ls\nwriter_rules.txt chapter_01_preview.txt chapter_01.txt\nuser@linux:~/Documents$ cat writer_rules.txt\n保持人物位置与既有事件连续，使用场景和对话推进。\nuser@linux:~/Documents$ cat chapter_01_preview.txt\n${user}\nuser@linux:~/Documents$ file chapter_01.txt\n${check}\nuser@linux:~/Documents$ cat chapter_01.txt\n${text}`
    return { user, steps: [{ name: 'dispatch_chapter_example', argumentsJson: JSON.stringify({ [delivery.fieldName]: display }, null, 2),
      resultJson: '{"channel":"display_stream"}', isError: false }], assistant: display }
  }) }
}

/** Populate only the untouched old default as an unsaved draft; never migrate saved content. */
export function writerHistoryEditorDraft(saved: WriterHistorySettings): WriterHistoryConfig {
  return saved.revision === 1 && JSON.stringify(saved.config) === JSON.stringify(blankWriterHistory())
    ? exampleWriterHistory() : structuredClone(saved.config)
}
