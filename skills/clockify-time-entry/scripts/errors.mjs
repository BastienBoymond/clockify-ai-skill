const secrets = new Set();

export class SkillError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

export function rememberSecret(value) {
  if (typeof value === 'string' && value) secrets.add(value);
}

export function redact(value) {
  let text = String(value);
  for (const secret of secrets) {
    text = text.split(secret).join('[REDACTED]');
    text = text.split(encodeURIComponent(secret)).join('[REDACTED]');
  }
  return text;
}

export function jsonOutput(value) {
  // Redact string values before JSON escaping, so quoted or backslashed keys
  // cannot escape redaction and replacement cannot break JSON syntax.
  return JSON.stringify(value, (_key, item) => typeof item === 'string' ? redact(item) : item, 2);
}

export function errorResult(error) {
  if (error instanceof SkillError) {
    return { code: error.code, message: error.message, ...error.details };
  }
  // Do not serialize arbitrary exceptions: they can contain credentials or bodies.
  return { code: 'LOCAL_ERROR', message: 'The local operation failed. Check file access and the installation, then run status.' };
}

export function requireValue(condition, code, message, details) {
  if (!condition) throw new SkillError(code, message, details);
}
