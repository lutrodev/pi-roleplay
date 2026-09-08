import { requireValue } from '../../../../packages/rp-core/src/errors.ts'
import type { MessageInput } from '../../../../packages/rp-core/src/types.ts'
import type { FileRepository } from '../storage/file-repository.ts'

export function validateMessageInputs(inputs: MessageInput[], files: FileRepository) {
  requireValue(Array.isArray(inputs) && inputs.length > 0 && inputs.length <= 16, 'INVALID_REQUEST', '请填写消息或添加附件。')
  for (const input of inputs) {
    requireValue(typeof input.text === 'string' && [...input.text].length <= 200_000, 'INVALID_REQUEST', '消息文字过长，请分次发送。')
    requireValue(Array.isArray(input.attachmentIds) && input.attachmentIds.length <= 16 && input.attachmentIds.every(id => typeof id === 'string'), 'INVALID_REQUEST', '附件列表不正确。')
    requireValue(input.text.trim().length > 0 || input.attachmentIds.length > 0, 'INVALID_REQUEST', '请填写消息或添加附件。')
  }
  validateInputFiles(inputs.flatMap(input => input.attachmentIds), files)
}

export function validateInputFiles(ids: string[], files: FileRepository) {
  const fileIds = [...new Set(ids)]
  requireValue(fileIds.length <= 16, 'ATTACHMENT_LIMIT', '每轮最多使用 16 个附件。')
  requireValue(fileIds.reduce((sum, id) => sum + files.get(id).size, 0) <= 50 * 1024 * 1024, 'ATTACHMENT_LIMIT', '每轮附件总量不能超过 50 MB。')
  return fileIds.map(id => files.get(id))
}
