import type { StoryNotice } from '../../../../packages/protocol/src/reading.ts'
import type { StoryData } from './api.ts'

function projectNotice(current: StoryData | undefined, record: StoryNotice) {
  if (!current || record.storyId !== current.story.id || record.seq <= current.story.revision) return current
  return { ...current, story: { ...current.story, revision: record.seq },
    runs: record.type === 'run.draft' ? current.runs.map(run => run.id === record.data.runId ? {
      ...run, draft: record.data.replace ? String(record.data.text) : run.draft + String(record.data.text),
    } : run) : current.runs,
  }
}

/** Reconcile streamed deltas with full snapshots, including HTTP responses that arrive after newer SSE events. */
export class StoryFeed {
  private latest?: StoryData
  private pending: StoryNotice[] = []
  constructor(private readonly storyId: string) {}

  receive(current: StoryData | undefined, record: StoryNotice) {
    if (record.storyId !== this.storyId || record.seq <= Math.max(this.latest?.story.revision ?? 0, this.pending.at(-1)?.seq ?? 0, current?.story.revision ?? 0)) return current
    this.pending.push(record)
    return projectNotice(current, record)
  }

  snapshot(incoming: StoryData): StoryData {
    if (!this.latest || incoming.story.revision >= this.latest.story.revision) this.latest = incoming
    // A full snapshot already contains these deltas. Retain only events after its durable boundary.
    this.pending = this.pending.filter(record => record.seq > this.latest!.story.revision)
    return this.pending.reduce<StoryData>((current, record) => projectNotice(current, record)!, this.latest)
  }
}
