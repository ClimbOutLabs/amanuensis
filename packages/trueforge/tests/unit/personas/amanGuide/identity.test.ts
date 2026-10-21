import {
  IRIS_DESCRIPTION,
  IRIS_NAME,
  amanGuidePersonaId,
  isAmanGuidePersona,
} from '../../../../src/personas/amanGuide/identity';

describe('Iris identity', () => {
  it('is named Iris and describes herself in plain words', () => {
    expect(IRIS_NAME).toBe('Iris');
    expect(IRIS_DESCRIPTION).toBe('Your guide to Aman. Ask me anything about how Aman works.');
  });

  it('recognises only the guide the same person owns', () => {
    const userId = 'person-1';
    const guideId = amanGuidePersonaId(userId);
    expect(isAmanGuidePersona({ id: guideId, created_by: userId })).toBe(true);
    expect(isAmanGuidePersona({ id: guideId, created_by: 'person-2' })).toBe(false);
    expect(isAmanGuidePersona({ id: 'iris-named-by-hand', created_by: userId })).toBe(false);
  });
});
