const WRITING_STYLE_EDITABLE_FIELDS = new Set(['name', 'description', 'content'])

export function normalizeStyle(value, config) {
  if (!objectLike(value)) throw coded('INVALID_REQUEST', 'Writing style must be an object.')
  const name = requiredText(value.name, 'name', 120)
  const description = optionalText(value.description, 'description', 2000)
  const content = requiredText(value.content, 'content', config.maxTextCharacters)
  const total = [name, description, content].reduce((sum, text) => sum + [...text].length, 0)
  if (total > config.maxTextCharacters) throw coded('LIMIT_EXCEEDED', `Writing style text exceeds the ${config.maxTextCharacters} character limit.`)
  return { name, description, content }
}

export function validateEditableStyle(value) {
  if (!objectLike(value)) throw coded('INVALID_REQUEST', 'Writing style must be an object.')
  const unknownField = Object.keys(value).find(key => !WRITING_STYLE_EDITABLE_FIELDS.has(key))
  if (unknownField !== undefined) throw coded('INVALID_REQUEST', `Writing style contains unknown field "${unknownField}".`)
}

function requiredText(value, field, limit) { if (typeof value !== 'string' || value.trim().length === 0) throw coded('INVALID_REQUEST', `Writing style ${field} must be a non-empty string.`); const text = value.replaceAll('\r\n', '\n').replaceAll('\r', '\n').trim(); if ([...text].length > limit) throw coded('LIMIT_EXCEEDED', `Writing style ${field} exceeds ${limit} characters.`); return text }

function optionalText(value, field, limit) { if (value === undefined || value === null || value === '') return ''; if (typeof value !== 'string') throw coded('INVALID_REQUEST', `Writing style ${field} must be a string.`); const text = value.replaceAll('\r\n', '\n').replaceAll('\r', '\n').trim(); if ([...text].length > limit) throw coded('LIMIT_EXCEEDED', `Writing style ${field} exceeds ${limit} characters.`); return text }

function objectLike(value) { return typeof value === 'object' && value !== null && !Array.isArray(value) }

function coded(code, message, cause) { const error = new Error(message, { cause }); error.code = code; return error }
