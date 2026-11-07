import {
  CallSidSchema,
  CallStatusParamsSchema,
  PhoneCallSchema,
  VoiceWebhookParamsSchema,
} from '../../../src/schemas/phoneCalls';

const SID = `CA${'0123456789abcdef'.repeat(2)}`;

describe('the phone call schemas', () => {
  it('takes only a Twilio call id: CA and 32 hex digits', () => {
    expect(CallSidSchema.safeParse(SID).success).toBe(true);
    expect(CallSidSchema.safeParse(`CA${'A'.repeat(32)}`).success).toBe(true);
    for (const sid of [
      `CA${'0'.repeat(31)}`,
      `CA${'0'.repeat(33)}`,
      `SM${'0'.repeat(32)}`,
      `CA${'g'.repeat(32)}`,
      `${SID}\n`,
    ]) {
      expect(CallSidSchema.safeParse(sid).success).toBe(false);
    }
  });

  it('reads who answered only from the values Twilio sends, and allows it to be missing', () => {
    expect(VoiceWebhookParamsSchema.safeParse({ AccountSid: 'AC1', CallSid: SID }).success).toBe(true);
    expect(VoiceWebhookParamsSchema.safeParse({ AccountSid: 'AC1', CallSid: SID, AnsweredBy: 'unknown' }).success).toBe(
      true,
    );
    expect(VoiceWebhookParamsSchema.safeParse({ AccountSid: 'AC1', CallSid: SID, AnsweredBy: 'robot' }).success).toBe(
      false,
    );
    expect(VoiceWebhookParamsSchema.safeParse({ AccountSid: '', CallSid: SID }).success).toBe(false);
  });

  it('reads only the call statuses Twilio sends', () => {
    expect(CallStatusParamsSchema.safeParse({ AccountSid: 'AC1', CallSid: SID, CallStatus: 'no-answer' }).success).toBe(
      true,
    );
    expect(CallStatusParamsSchema.safeParse({ AccountSid: 'AC1', CallSid: SID, CallStatus: 'answered' }).success).toBe(
      false,
    );
  });

  it('keeps a stored call to its known statuses, outcomes, modes and fallback states', () => {
    const call = {
      id: 'call-1',
      tenant_id: 'default',
      created_by: 'alice',
      delivery_id: 'delivery-1',
      call_sid: null,
      status: 'dialing',
      outcome: null,
      mode: null,
      session_id: null,
      fallback: 'pending',
      created_at: '2026-11-06T09:00:00.000Z',
      expires_at: '2026-11-06T09:05:00.000Z',
      ended_at: null,
    };
    expect(PhoneCallSchema.safeParse(call).success).toBe(true);
    expect(PhoneCallSchema.safeParse({ ...call, status: 'ended', outcome: 'no_answer', mode: 'talk' }).success).toBe(
      true,
    );
    expect(PhoneCallSchema.safeParse({ ...call, status: 'answered' }).success).toBe(false);
    expect(PhoneCallSchema.safeParse({ ...call, outcome: 'missed' }).success).toBe(false);
    expect(PhoneCallSchema.safeParse({ ...call, mode: 'fax' }).success).toBe(false);
    expect(PhoneCallSchema.safeParse({ ...call, fallback: 'sent' }).success).toBe(false);
    expect(PhoneCallSchema.safeParse({ ...call, id: '' }).success).toBe(false);
  });
});
