import type { FastifyReply, FastifyRequest } from 'fastify'
import type {} from '@fastify/multipart'
import { RpError, requireValue } from '../../../../packages/rp-core/src/errors.ts'

/** Read the entire bounded multipart request before persisting anything. Extra files are an error. */
export async function singleUpload(request: FastifyRequest, fileSize?: number) {
  let upload: { bytes: Buffer; name: string; mimeType: string } | undefined
  try {
    for await (const part of request.parts({ limits: { files: 1, fields: 0, parts: 1, ...(fileSize === undefined ? {} : { fileSize }) } })) {
      requireValue(part.type === 'file' && part.fieldname === 'file' && !upload, 'INVALID_UPLOAD', '请选择一个文件上传。')
      upload = { bytes: await part.toBuffer(), name: part.filename, mimeType: part.mimetype }
      requireValue(!part.file.truncated, 'UPLOAD_TOO_LARGE', '上传文件超过大小限制。', 413)
    }
  } catch (error) {
    // Busboy may close the current file before its queued parts-limit error is delivered.
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ERR_STREAM_PREMATURE_CLOSE') throw new RpError('UPLOAD_INCOMPLETE', '上传未完成或文件数量超过限制，请只选择一个文件重试。')
    throw error
  }
  requireValue(upload, 'INVALID_UPLOAD', '请选择一个文件上传。')
  return upload
}

export function sendDownload(reply: FastifyReply, bytes: Buffer, name: string, mimeType: string, inline = false) {
  return downloadHeaders(reply, name, mimeType, inline).send(bytes)
}
export function downloadHeaders(reply: FastifyReply, name: string, mimeType: string, inline = false) {
  const filename = encodeURIComponent(Buffer.from(name).toString('utf8')).replace(/['()*]/g, char => '%' + char.charCodeAt(0).toString(16).toUpperCase())
  return reply.header('content-type', mimeType).header('x-content-type-options', 'nosniff')
    .header('content-security-policy', "default-src 'none'; sandbox")
    .header('content-disposition', `${inline ? 'inline' : 'attachment'}; filename="download"; filename*=UTF-8''${filename}`)
    .header('cache-control', 'no-store')
}
