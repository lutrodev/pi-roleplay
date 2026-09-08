import { randomUUID } from 'node:crypto'

const PRESET_POSITIONS = new Set(['top', 'bottom'])

const PRESET_EDITABLE_FIELDS = new Set(['name', 'description', 'fields'])

const PRESET_FIELD_EDITABLE_FIELDS = new Set(['id', 'name', 'description', 'content', 'position', 'sectionTag'])

const PRESET_FIELD_ID = /^[0-9a-f-]{36}$/

export function normalizePreset(value, config, requireFieldIds = false) {
  if (!objectLike(value)) throw coded('INVALID_REQUEST', 'Preset must be an object.')
  const name = requiredText(value.name, 'name', 120)
  const description = optionalText(value.description, 'description', 2000)
  const sourceFields = value.fields ?? []
  if (!Array.isArray(sourceFields) || sourceFields.length > config.maxFields) throw coded('INVALID_REQUEST', `Preset fields must contain between 0 and ${config.maxFields} entries.`)
  const fields = sourceFields.map((field, index) => normalizeField(field, index, requireFieldIds))
  if (new Set(fields.map(field => field.id)).size !== fields.length) throw coded('INVALID_REQUEST', 'Preset field ids must be unique.')
  const total = [name, description, ...fields.flatMap(field => [field.name, field.description, field.content])].reduce((sum, text) => sum + [...text].length, 0)
  if (total > config.maxTextCharacters) throw coded('LIMIT_EXCEEDED', `Preset text exceeds the ${config.maxTextCharacters} character limit.`)
  return { name, description, fields }
}

export function validateEditablePreset(value, { update = false } = {}) {
  if (!objectLike(value)) throw coded('INVALID_REQUEST', 'Preset must be an object.')
  const unknownField = Object.keys(value).find(key => !PRESET_EDITABLE_FIELDS.has(key))
  if (unknownField !== undefined) throw coded('INVALID_REQUEST', `Preset contains unknown field "${unknownField}".`)
  if (update) {
    for (const field of ['name', 'description', 'fields']) {
      if (!Object.hasOwn(value, field)) throw coded('INVALID_REQUEST', `Preset update requires the complete editable body, including ${field}.`)
    }
    if (typeof value.description !== 'string') throw coded('INVALID_REQUEST', 'Preset update description must be a string.')
  }
  if (!Object.hasOwn(value, 'fields')) return
  if (!Array.isArray(value.fields)) throw coded('INVALID_REQUEST', 'Preset fields must be an array.')
  for (const [index, field] of value.fields.entries()) {
    if (!objectLike(field)) throw coded('INVALID_REQUEST', `Preset field ${index + 1} must be an object.`)
    const unknownField = Object.keys(field).find(key => !PRESET_FIELD_EDITABLE_FIELDS.has(key))
    if (unknownField !== undefined) throw coded('INVALID_REQUEST', `Preset field ${index + 1} contains unknown field "${unknownField}".`)
    if ((field.id !== undefined || update) && (typeof field.id !== 'string' || !PRESET_FIELD_ID.test(field.id))) {
      throw coded('INVALID_REQUEST', `Preset field ${index + 1} id must be a valid UUID.`)
    }
    if (!update) continue
    for (const requiredField of PRESET_FIELD_EDITABLE_FIELDS) {
      if (!Object.hasOwn(field, requiredField)) throw coded('INVALID_REQUEST', `Preset update field ${index + 1} requires ${requiredField}.`)
    }
    if (typeof field.description !== 'string' || typeof field.content !== 'string') throw coded('INVALID_REQUEST', `Preset update field ${index + 1} description and content must be strings.`)
    if (typeof field.sectionTag !== 'boolean') throw coded('INVALID_REQUEST', `Preset field ${index + 1} sectionTag must be a boolean.`)
  }
}

function normalizeField(value, index, requireFieldId) {
  if (!objectLike(value)) throw coded('INVALID_REQUEST', `Preset field ${index + 1} must be an object.`)
  if (requireFieldId && (typeof value.id !== 'string' || !PRESET_FIELD_ID.test(value.id))) throw coded('ASSET_CORRUPT', `Preset field ${index + 1} has invalid storage metadata.`)
  const position = value.position
  if (!PRESET_POSITIONS.has(position)) throw coded(requireFieldId ? 'ASSET_CORRUPT' : 'INVALID_REQUEST', `Preset field ${index + 1} position must be top or bottom.`)
  return {
    id: typeof value.id === 'string' && PRESET_FIELD_ID.test(value.id) ? value.id : randomUUID(),
    name: requiredText(value.name, `field ${index + 1} name`, 120),
    description: optionalText(value.description, `field ${index + 1} description`, 1000),
    content: optionalText(value.content, `field ${index + 1} content`, 100000),
    position,
    sectionTag: defaultBoolean(value.sectionTag, `Preset field ${index + 1} sectionTag`),
  }
}

function requiredText(value, field, limit) { if (typeof value !== 'string' || value.trim().length === 0) throw coded('INVALID_REQUEST', `Preset ${field} must be a non-empty string.`); const text = value.trim(); if ([...text].length > limit) throw coded('LIMIT_EXCEEDED', `Preset ${field} exceeds ${limit} characters.`); return text }

function optionalText(value, field, limit) { if (value === undefined || value === null || value === '') return ''; if (typeof value !== 'string') throw coded('INVALID_REQUEST', `Preset ${field} must be a string.`); const text = value.replaceAll('\r\n', '\n').replaceAll('\r', '\n').trim(); if ([...text].length > limit) throw coded('LIMIT_EXCEEDED', `Preset ${field} exceeds ${limit} characters.`); return text }

function defaultBoolean(value, field) { if (value === undefined) return true; if (typeof value !== 'boolean') throw coded('INVALID_REQUEST', `${field} must be a boolean.`); return value }

function objectLike(value) { return typeof value === 'object' && value !== null && !Array.isArray(value) }

function coded(code, message, cause) { const error = new Error(message, { cause }); error.code = code; return error }
