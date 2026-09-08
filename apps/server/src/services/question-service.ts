import { randomUUID } from 'node:crypto'
import { RpError, requireValue } from '../../../../packages/rp-core/src/errors.ts'
import { normalizeAnswers, normalizeQuestions } from '../../../../packages/rp-core/src/interaction/questions.ts'
import type { QuestionAnswer, UserQuestion } from '../../../../packages/rp-core/src/types.ts'
import type { StoryRepository } from '../storage/story-repository.ts'

/** Questions and answers survive browser reloads. Only the live process can resume its suspended Pi tool. */
export class QuestionService {
  private readonly waiting = new Map<string, (answers: QuestionAnswer[]) => void>()
  constructor(readonly stories: StoryRepository) {}

  async ask(runId: string, callId: string, input: unknown, signal: AbortSignal): Promise<{ answers: QuestionAnswer[] }> {
    signal.throwIfAborted()
    requireValue(typeof callId === 'string' && callId.length > 0 && callId.length <= 256, 'INVALID_QUESTION', '提问调用标识不正确。')
    const questions = normalizeQuestions(input)
    const run = this.stories.run(runId), story = this.stories.snapshot(run.storyId)
    requireValue(story.profile.runtime.executionMode === 'agent', 'AGENT_MODE_REQUIRED', '用户提问工具只在 Agent 模式可用。')
    const key = `question:${runId}:${callId}`
    const previous = this.stories.findEvent(run.storyId, key)
    if (previous?.type === 'question.asked') {
      requireValue(JSON.stringify(previous.data.questions) === JSON.stringify(questions), 'QUESTION_CONFLICT', '相同调用标识不能用于不同问题。', 409)
      const existing = story.questions.find(item => item.id === previous.data.id)!
      if (existing.status === 'answered') return { answers: structuredClone(existing.answers!) }
      throw new RpError('QUESTION_NOT_RESUMABLE', '这个问题仍在等待或已被中断，不能重新发起相同提问。', 409)
    }
    requireValue(run.status === 'running', 'RUN_STATE_CONFLICT', '这次生成已不在运行。', 409)
    const question: UserQuestion = { id: randomUUID(), runId, questions, status: 'pending' }
    this.stories.database.transaction(() => {
      this.stories.append(run.storyId, { type: 'question.asked', data: question }, key)
      this.stories.setRunStatus(runId, 'waiting_user')
    })
    return await new Promise<{ answers: QuestionAnswer[] }>((resolve, reject) => {
      const abort = () => {
        try {
          this.stories.database.transaction(() => {
            if (this.stories.run(runId).status === 'waiting_user') {
              this.stories.append(run.storyId, { type: 'question.cancelled', data: { questionId: question.id } })
              this.stories.setRunStatus(runId, 'running')
            }
          })
          reject(signal.reason)
        } catch (error) { reject(error) }
        finally { cleanup() }
      }
      const cleanup = () => { this.waiting.delete(question.id); signal.removeEventListener('abort', abort) }
      this.waiting.set(question.id, answers => { cleanup(); resolve({ answers: structuredClone(answers) }) })
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) abort()
    })
  }

  answer(storyId: string, questionId: string, input: unknown) {
    const result = this.stories.database.transaction(() => {
      const question = this.stories.snapshot(storyId).questions.find(item => item.id === questionId)
      requireValue(question, 'QUESTION_NOT_FOUND', '这个问题不存在。', 404)
      const answers = normalizeAnswers(question.questions, input)
      if (question.status === 'answered') {
        requireValue(JSON.stringify(question.answers) === JSON.stringify(answers), 'ANSWER_CONFLICT', '这个问题已经收到不同的回答。', 409)
        return { answers, duplicate: true }
      }
      requireValue(question.status === 'pending' && this.stories.run(question.runId).status === 'waiting_user' && this.waiting.has(questionId), 'QUESTION_NOT_RESUMABLE', '提问已结束或服务重启中断了这次生成，请重新发起生成。', 409)
      this.stories.append(storyId, { type: 'question.answered', data: { questionId, answers } }, `answer:${questionId}`)
      this.stories.setRunStatus(question.runId, 'running')
      return { answers, duplicate: false }
    })
    if (!result.duplicate) this.waiting.get(questionId)!(result.answers)
    return result
  }
}
