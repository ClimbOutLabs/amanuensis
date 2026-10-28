import { BACKGROUND_NOT_WORK_SENTENCE } from '../../../src/personalization/backgroundFraming';

describe('BACKGROUND_NOT_WORK_SENTENCE', () => {
  it.each([
    'never work to start',
    'not a request',
    'latest message',
    'nothing to do yet',
    'read together with this chat so far',
  ])('says "%s"', phrase => {
    expect(BACKGROUND_NOT_WORK_SENTENCE).toContain(phrase);
  });

  it('does not name the assistant', () => {
    expect(BACKGROUND_NOT_WORK_SENTENCE).not.toMatch(/aman|mannie/i);
  });
});
