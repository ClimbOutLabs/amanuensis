import type { DoctorDeps, HttpResponse } from '../../../../src/cli/doctor/deps';

export const NOW_MS = Date.parse('2026-10-10T12:00:00Z');

export type FakeGet = (options: { url: string; timeoutMs: number }) => Promise<HttpResponse>;

export function fakeDeps(overrides: Partial<DoctorDeps> = {}): DoctorDeps {
  return {
    env: {},
    nowMs: () => NOW_MS,
    get: () => Promise.reject(new Error('unexpected request')),
    freeBytes: () => Promise.resolve(50 * 1024 ** 3),
    probeDatabaseWritable: () => undefined,
    slotsReadiness: () => Promise.reject(new Error('unexpected sandbox probe')),
    ...overrides,
  };
}

export function response({ status = 200, json }: { status?: number; json?: unknown } = {}): HttpResponse {
  return { status, json };
}

export function networkError(code: string): Error {
  return new Error('fetch failed', { cause: Object.assign(new Error(code), { code }) });
}
