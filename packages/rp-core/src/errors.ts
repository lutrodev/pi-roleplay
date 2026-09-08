export class RpError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly statusCode = 400,
    readonly details?: unknown,
  ) {
    super(message)
    this.name = 'RpError'
  }
}

export function requireValue(condition: unknown, code: string, message: string, statusCode = 400): asserts condition {
  if (!condition) throw new RpError(code, message, statusCode)
}
