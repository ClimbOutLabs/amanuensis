import { isFromSession } from '../../../../src/runtime/memory/recallRelevance';

describe('isFromSession', () => {
  it('matches only the recorded chat id', () => {
    expect(isFromSession({ metadata: { session_id: 's1' }, sessionId: 's1' })).toBe(true);
    expect(isFromSession({ metadata: { session_id: 's2' }, sessionId: 's1' })).toBe(false);
  });

  it('treats a note with no recorded chat, or no current chat, as another chat', () => {
    expect(isFromSession({ metadata: undefined, sessionId: 's1' })).toBe(false);
    expect(isFromSession({ metadata: { origin: 'user_stated' }, sessionId: 's1' })).toBe(false);
    expect(isFromSession({ metadata: { session_id: 's1' }, sessionId: undefined })).toBe(false);
    expect(isFromSession({ metadata: { session_id: '' }, sessionId: '' })).toBe(false);
  });
});
