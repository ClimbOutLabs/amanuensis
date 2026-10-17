/**
 * Narrowing helpers for tests that read or rewrite archive JSON, so they
 * check shapes instead of asserting them.
 */
export type JsonRecord = Record<string, unknown>;

export function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function recordAt(value: unknown, label: string): JsonRecord {
  if (!isRecord(value)) {
    throw new Error(`test data: ${label} is not an object`);
  }
  return value;
}

export function listAt(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`test data: ${label} is not a list`);
  }
  return value;
}

export function recordsAt(value: unknown, label: string): JsonRecord[] {
  return listAt(value, label).map((item, index) => recordAt(item, `${label}[${String(index)}]`));
}

export function stringAt(value: unknown, label: string): string {
  if (typeof value !== 'string') {
    throw new Error(`test data: ${label} is not a string`);
  }
  return value;
}

/** Parses JSON text into `unknown`, for the guards above. */
export function parseJson(text: string | Buffer | undefined, label: string): unknown {
  if (text === undefined) {
    throw new Error(`test data: ${label} is missing`);
  }
  const parsed: unknown = JSON.parse(text.toString());
  return parsed;
}
