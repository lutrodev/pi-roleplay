import { Type } from '@sinclair/typebox'

export const strict = { additionalProperties: false }
export const id = Type.String({ minLength: 1, maxLength: 128 })
export const revision = Type.Integer({ minimum: 1 })
export const dataObject = Type.Object({}, { additionalProperties: true })
export const revisionBody = Type.Object({ expectedRevision: revision }, strict)
export type Revision = { expectedRevision: number }
