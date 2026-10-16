import { z } from 'zod';

export const CheckStateSchema = z.enum(['ok', 'warn', 'fail', 'off']);

/** One doctor result. A warn or fail always says how to fix it, in plain language. */
export const CheckSchema = z
  .object({
    id: z.string().min(1),
    state: CheckStateSchema,
    detail: z.string().min(1),
    fix: z.string(),
  })
  .refine(check => check.fix.trim() !== '' || check.state === 'ok' || check.state === 'off', {
    message: 'A warn or fail check needs a fix.',
    path: ['fix'],
  });

export type Check = z.infer<typeof CheckSchema>;

export function okCheck({ id, detail }: { id: string; detail: string }): Check {
  return { id, state: 'ok', detail, fix: '' };
}

export function offCheck({ id, detail }: { id: string; detail: string }): Check {
  return { id, state: 'off', detail, fix: '' };
}

export function warnCheck({ id, detail, fix }: { id: string; detail: string; fix: string }): Check {
  return { id, state: 'warn', detail, fix };
}

export function failCheck({ id, detail, fix }: { id: string; detail: string; fix: string }): Check {
  return { id, state: 'fail', detail, fix };
}
