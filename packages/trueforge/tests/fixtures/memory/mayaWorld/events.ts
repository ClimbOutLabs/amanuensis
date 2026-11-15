import { z } from 'zod';

import { mayaPageSlug } from './pages';
import { MayaEventSchema, type MayaEvent } from './schema';

/** What happens to the vault outside the daily log. */
export const MAYA_EVENTS: readonly MayaEvent[] = z.array(MayaEventSchema).parse([
  {
    day: 20,
    kind: 'hand_edit',
    about: mayaPageSlug('nora'),
    before_line: 'Nora is allergic to shellfish.',
    after_line: 'Nora is allergic to shellfish and kiwi.',
  },
]);
