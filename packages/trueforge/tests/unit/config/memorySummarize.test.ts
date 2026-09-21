import configuration from '../../../src/config';

/**
 * Turn summarization ships ON: it needs only the chat model (already required),
 * failures fall back to the verbatim transcript, and the Settings toggle shows the
 * effective state truthfully, so users who don't want it can see it and switch it off.
 */
describe('MEMORY_SUMMARIZE default', () => {
  it('defaults to true when the env var is unset', () => {
    expect(process.env['MEMORY_SUMMARIZE']).toBeUndefined();
    expect(configuration.MEMORY_SUMMARIZE).toBe(true);
  });
});
