import Ajv from 'ajv'

const ajv = new Ajv({ allErrors: true, strict: false, coerceTypes: false, removeAdditional: false })
const validators = new WeakMap()

/** Validate external JSON without coercing, stripping or silently accepting fields. */
export function validateJsonSchemaValue(schema, value, path = '') {
  let validate = validators.get(schema)
  if (validate === undefined) {
    validate = ajv.compile(schema)
    validators.set(schema, validate)
  }
  if (validate(value)) return []
  return (validate.errors ?? []).map(error => ({
    path: `${path}${error.instancePath}`,
    message: error.message ?? 'Invalid value',
    keyword: error.keyword,
    params: error.params,
  }))
}
