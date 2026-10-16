import { CheckSchema, failCheck, offCheck, okCheck, warnCheck } from '../../../../src/cli/doctor/schemas';

describe('doctor check schema', () => {
  it('accepts ok and off without a fix', () => {
    expect(CheckSchema.safeParse(okCheck({ id: 'a', detail: 'fine' })).success).toBe(true);
    expect(CheckSchema.safeParse(offCheck({ id: 'a', detail: 'reason' })).success).toBe(true);
  });

  it('requires a non-blank fix on warn and fail', () => {
    expect(CheckSchema.safeParse(warnCheck({ id: 'a', detail: 'd', fix: 'do this' })).success).toBe(true);
    expect(CheckSchema.safeParse(failCheck({ id: 'a', detail: 'd', fix: 'do this' })).success).toBe(true);
    expect(CheckSchema.safeParse(warnCheck({ id: 'a', detail: 'd', fix: '' })).success).toBe(false);
    expect(CheckSchema.safeParse(failCheck({ id: 'a', detail: 'd', fix: '   ' })).success).toBe(false);
  });

  it('rejects unknown states', () => {
    expect(CheckSchema.safeParse({ id: 'a', state: 'maybe', detail: 'd', fix: '' }).success).toBe(false);
  });
});
