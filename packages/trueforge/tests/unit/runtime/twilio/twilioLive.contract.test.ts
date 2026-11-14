import { createTwilioCallProvider } from '../../../../src/runtime/calls/twilioCalls';
import { createTwilioSmsProvider } from '../../../../src/runtime/texts/smsProvider';

/**
 * Our own providers against the real Twilio API, signed in with Twilio's test credentials and its magic numbers, so
 * nothing is sent, nobody is called and nothing is charged. Without the two secrets the file skips; nothing here
 * prints the sign-in details, and the checks only look at what our providers return.
 */
const accountSid = process.env['TWILIO_TEST_ACCOUNT_SID'] ?? '';
const authToken = process.env['TWILIO_TEST_AUTH_TOKEN'] ?? '';
const configured = accountSid !== '' && authToken !== '';

if (!configured) {
  process.stderr.write('Twilio live check skipped: TWILIO_TEST_ACCOUNT_SID and TWILIO_TEST_AUTH_TOKEN are not set.\n');
}

/** Twilio's documented "From" number that always works with test credentials. */
const MAGIC_FROM = '+15005550006';
/** An ordinary number: test credentials accept any valid number that is not one of the magic failures. */
const VALID_TO = '+14155552671';
/** Twilio's documented "To" numbers for a number that is invalid and for one that replied STOP. */
const INVALID_TO = '+15005550001';
const OPTED_OUT_TO = '+15005550004';

const settings = { accountSid, authToken, fromNumber: MAGIC_FROM, webhookPublicUrl: 'https://aman.example.invalid' };

(configured ? describe : describe.skip)('our Twilio providers against Twilio test credentials', () => {
  const texts = createTwilioSmsProvider({ settings });
  const calls = createTwilioCallProvider({ settings });

  it('sends a text through our sender to a valid number', async () => {
    const result = await texts.send({ to: VALID_TO, body: 'Synthetic test text.' });
    expect(result.outcome).toBe('sent');
  });

  it('maps an invalid number to invalid_number', async () => {
    const result = await texts.send({ to: INVALID_TO, body: 'Synthetic test text.' });
    expect(result).toEqual({ outcome: 'failed', failure: 'invalid_number' });
  });

  it('maps a number that replied STOP to opted_out', async () => {
    const result = await texts.send({ to: OPTED_OUT_TO, body: 'Synthetic test text.' });
    expect(result).toEqual({ outcome: 'failed', failure: 'opted_out' });
  });

  it('creates a call through our call provider for a valid number', async () => {
    const result = await calls.place({ to: VALID_TO, call_id: '0'.repeat(26) });
    expect(result.outcome).toBe('started');
    expect(result.outcome === 'started' && /^CA[0-9a-f]{32}$/.test(result.call_sid)).toBe(true);
  });

  it('maps an invalid number on a call to invalid_number', async () => {
    const result = await calls.place({ to: INVALID_TO, call_id: '0'.repeat(26) });
    expect(result).toEqual({ outcome: 'failed', failure: 'invalid_number' });
  });

  it('is refused sign-in details that are wrong, without saying them', async () => {
    const wrong = createTwilioSmsProvider({ settings: { ...settings, authToken: 'wrong'.repeat(7) } });
    const result = await wrong.send({ to: VALID_TO, body: 'Synthetic test text.' });
    expect(result).toEqual({ outcome: 'failed', failure: 'not_accepted' });
  });
});
