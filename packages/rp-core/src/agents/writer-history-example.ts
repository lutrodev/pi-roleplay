import { blankWriterHistory, type WriterHistoryConfig, type WriterHistorySettings } from './writer-history.ts'
import initialCase from './writer-history-example.json'

/** Two writing conversations, with the topic and generated text left for the user to fill. */
export function exampleWriterHistory(): WriterHistoryConfig {
  return structuredClone(initialCase)
}

/** Populate only the untouched old default as an unsaved draft; never migrate saved content. */
export function writerHistoryEditorDraft(saved: WriterHistorySettings): WriterHistoryConfig {
  return saved.revision === 1 && JSON.stringify(saved.config) === JSON.stringify(blankWriterHistory())
    ? exampleWriterHistory() : structuredClone(saved.config)
}
