import { AMAN_GUIDE_DESCRIPTION, AMAN_GUIDE_NAME } from '@truefoundry/trueforge-core/core/personas/guide';
import {
  amanGuidePersonaId,
  isAmanGuidePersona,
  isAnyAmanGuideId,
  legacyAmanGuidePersonaId,
} from '../../../../src/personas/amanGuide/identity';

describe('Iris identity', () => {
  it('is named Iris and describes herself in plain words', () => {
    expect(AMAN_GUIDE_NAME).toBe('Iris');
    expect(AMAN_GUIDE_DESCRIPTION).toBe('Your guide to Aman. Ask me anything about how Aman works.');
  });

  it('recognises only the guide the same person owns', () => {
    const userId = 'person-1';
    const guideId = amanGuidePersonaId(userId);
    expect(isAmanGuidePersona({ id: guideId, created_by: userId })).toBe(true);
    expect(isAmanGuidePersona({ id: guideId, created_by: 'person-2' })).toBe(false);
    expect(isAmanGuidePersona({ id: 'iris-named-by-hand', created_by: userId })).toBe(false);
  });

  it('recognises the guide under the id it had before the rename', () => {
    const userId = 'person-1';
    expect(isAmanGuidePersona({ id: legacyAmanGuidePersonaId(userId), created_by: userId })).toBe(true);
    expect(isAmanGuidePersona({ id: legacyAmanGuidePersonaId(userId), created_by: 'person-2' })).toBe(false);
  });

  it('accepts a guide id of any owner and version, and nothing else', () => {
    expect(isAnyAmanGuideId(amanGuidePersonaId('someone'))).toBe(true);
    expect(isAnyAmanGuideId(legacyAmanGuidePersonaId('someone'))).toBe(true);
    expect(isAnyAmanGuideId('iris-named-by-hand')).toBe(false);
    expect(isAnyAmanGuideId('persona-1')).toBe(false);
  });
});
