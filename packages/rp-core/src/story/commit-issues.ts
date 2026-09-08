import { RpError } from '../errors.ts'

export interface CommitIssue { code: string; path: string; message: string; statusCode?: number; [key: string]: unknown }

/** Retain domain JSON Pointers when lifting one capability's errors into a commit. */
export function commitIssues(error: unknown, prefix: string): CommitIssue[] {
  const code = error instanceof RpError ? error.code : 'COMMIT_INVALID'
  const message = error instanceof Error ? error.message : '这项提交内容不正确。'
  const details = error instanceof RpError ? error.details : undefined
  const values = Array.isArray(details) && details.length ? details : [{ code, message }]
  return values.map(value => {
    const issue = value && typeof value === 'object' ? value as Record<string, unknown> : { message: String(value) }
    return { summary: message, ...issue, code: typeof issue.code === 'string' ? issue.code : code,
      path: prefix + (typeof issue.path === 'string' ? issue.path : ''), message: typeof issue.message === 'string' ? issue.message : message,
      ...(error instanceof RpError ? { statusCode: error.statusCode } : {}),
    }
  })
}

export function rejectCommitIssues(issues: CommitIssue[]) {
  if (issues.length) throw new RpError(issues[0]!.code, typeof issues[0]!.summary === 'string' ? issues[0]!.summary : issues[0]!.message, issues[0]!.statusCode ?? 400, issues)
}
