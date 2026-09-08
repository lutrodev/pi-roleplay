const PERSONA_EDITABLE_FIELDS = new Set(['name', 'description', 'personality', 'scenario', 'firstMessage', 'tags'])

export function normalizePersona(value, maxTextCharacters) {
  if (!objectLike(value)) throw coded('INVALID_REQUEST', 'Persona must be an object.')
  const persona = {
    name: requiredText(value.name, 'name'),
    description: optionalText(value.description, 'description'),
    personality: optionalText(value.personality, 'personality'),
    scenario: optionalText(value.scenario, 'scenario'),
    firstMessage: optionalText(value.firstMessage, 'firstMessage'),
    tags: tags(value.tags),
  }
  const total = [persona.name, persona.description, persona.personality, persona.scenario, persona.firstMessage, ...persona.tags].reduce((sum, text) => sum + [...text].length, 0)
  if (total > maxTextCharacters) throw coded('LIMIT_EXCEEDED', `Persona text exceeds the ${maxTextCharacters} character limit.`)
  return persona
}

export function validateEditablePersona(value) {
  if (!objectLike(value)) throw coded('INVALID_REQUEST', 'Persona must be an object.')
  const unknownField = Object.keys(value).find(key => !PERSONA_EDITABLE_FIELDS.has(key))
  if (unknownField !== undefined) throw coded('INVALID_REQUEST', `Persona contains unknown field "${unknownField}".`)
}

export function renderPersona(value) {
  return [
    `name: ${value.name}`,
    value.description ? `description: ${value.description}` : '',
    value.personality ? `personality: ${value.personality}` : '',
    value.scenario ? `scenario: ${value.scenario}` : '',
    value.firstMessage ? `example_voice: ${value.firstMessage}` : '',
  ].filter(Boolean).join('\n')
}

function requiredText(value, field) { if (typeof value !== 'string' || value.trim().length === 0) throw coded('INVALID_REQUEST', `Persona ${field} must be a non-empty string.`); return value.trim() }

function optionalText(value, field) { if (value === undefined || value === null || value === '') return ''; if (typeof value !== 'string') throw coded('INVALID_REQUEST', `Persona ${field} must be a string.`); return value.trim() }

function tags(value) { if (value === undefined) return []; if (!Array.isArray(value) || value.length > 64 || value.some(item => typeof item !== 'string' || item.trim().length === 0)) throw coded('INVALID_REQUEST', 'Persona tags must be a string array with at most 64 entries.'); return [...new Set(value.map(item => item.trim()))] }

function objectLike(value) { return typeof value === 'object' && value !== null && !Array.isArray(value) }

function coded(code, message, cause) { const error = new Error(message, { cause }); error.code = code; return error }
