import type { StoryRepository } from '../storage/story-repository.ts'

/** Search only current visible prose. Deleted text, earlier edits and model/tool logs are excluded. */
export function searchStories(repository: StoryRepository, archived: boolean, query = '') {
  const needle = query.trim().toLocaleLowerCase()
  // Streaming drafts and diagnostics must not move rows while the user is choosing a conversation.
  // Status follows the active run or projectStory's visible tail, including invalidation by deleted drafts.
  // Read message identities in SQL instead of loading full story/model payloads for every sidebar row.
  const catalog = repository.database.sqlite.prepare(`SELECT s.id,s.title,s.archived,s.created_at AS createdAt,
    COALESCE((SELECT e.created_at FROM events e WHERE e.story_id=s.id AND e.type NOT IN
      ('run.draft','model.message','maintenance.model','context.built','context.compacted','writer.completed','tool.started','tool.updated','tool.finished')
      ORDER BY e.seq DESC LIMIT 1),s.created_at) AS updatedAt,
    CASE WHEN r.status IN ('queued','running','waiting_user') THEN r.status
      WHEN NOT EXISTS (SELECT 1 FROM events removed,json_each(removed.data,'$.messageIds') ids
        JOIN events message ON message.story_id=removed.story_id AND message.type IN ('message.added','turn.committed')
          AND json_extract(message.data,'$.message.id')=ids.value
        WHERE removed.story_id=s.id AND removed.type='messages.removed' AND json_extract(message.data,'$.message.runId')=r.id)
      THEN r.status ELSE NULL END AS status,
    (SELECT json_extract(e.data,'$.forkedFrom.storyId') FROM events e WHERE e.story_id=s.id AND e.type='story.created' LIMIT 1) AS parentStoryId
    FROM stories s LEFT JOIN runs r ON r.story_id=s.id AND r.id=COALESCE(
      (SELECT live.id FROM runs live WHERE live.story_id=s.id AND live.status IN ('queued','running','waiting_user') ORDER BY live.created_at DESC,live.id DESC LIMIT 1),
      (SELECT json_extract(e.data,'$.message.runId') FROM events e WHERE e.story_id=s.id
        AND e.type IN ('message.added','turn.committed') AND json_extract(e.data,'$.message.kind')!='tool'
        AND NOT EXISTS (SELECT 1 FROM events removed,json_each(removed.data,'$.messageIds') ids
          WHERE removed.story_id=s.id AND removed.type='messages.removed' AND ids.value=json_extract(e.data,'$.message.id'))
        ORDER BY e.seq DESC LIMIT 1))
    WHERE s.archived=? ORDER BY updatedAt DESC,s.id DESC`).all(Number(archived)) as { id: string; title: string; archived: number; createdAt: string; updatedAt: string; status: string | null; parentStoryId: string | null }[]
  const matches = new Map<string, { messageId: string; snippet: string }>()
  if (needle) {
    const rows = repository.database.sqlite.prepare(`WITH visible AS (
      SELECT e.story_id AS storyId,e.seq,json_extract(e.data,'$.message.id') AS messageId,
        COALESCE((SELECT json_extract(edit.data,'$.text') FROM events edit WHERE edit.story_id=e.story_id AND edit.type='message.edited'
          AND json_extract(edit.data,'$.messageId')=json_extract(e.data,'$.message.id') ORDER BY edit.seq DESC LIMIT 1),json_extract(e.data,'$.message.text')) AS text
      FROM events e JOIN stories s ON s.id=e.story_id
      WHERE s.archived=? AND e.type IN ('message.added','turn.committed') AND json_extract(e.data,'$.message.kind')!='tool'
        AND NOT EXISTS (SELECT 1 FROM events removed,json_each(removed.data,'$.messageIds') ids
          WHERE removed.story_id=e.story_id AND removed.type='messages.removed' AND ids.value=json_extract(e.data,'$.message.id'))
    ) SELECT storyId,messageId,substr(text,max(1,instr(unicode_lower(text),?)-40),200) AS snippet FROM visible WHERE instr(unicode_lower(text),?)>0 ORDER BY seq DESC`).all(Number(archived), needle, needle) as { storyId: string; messageId: string; snippet: string }[]
    for (const row of rows) if (!matches.has(row.storyId)) matches.set(row.storyId, { messageId: row.messageId, snippet: row.snippet })
  }
  return catalog.filter(story => !needle || story.title.toLocaleLowerCase().includes(needle) || matches.has(story.id))
    .map(story => ({ ...story, archived: Boolean(story.archived), ...(matches.has(story.id) ? { match: matches.get(story.id)! } : {}) }))
}
