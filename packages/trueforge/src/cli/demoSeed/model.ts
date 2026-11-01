import type { AgentSpec } from '@truefoundry/trueforge-core/agent-session';
import type { PersonalizationProfileContent } from '../../personalization/profile';
import type { PersonaContent } from '../../personas/persona';
import type { ScheduleManifest } from '../../schemas/schedule';
import type { SpaceContent } from '../../schemas/space';

/** One fact the assistant remembers; `key` is stable across days so a re-seed updates the same entry. */
export interface DemoNote {
  key: string;
  body: string;
}

/** A knowledge document in a persona's library. */
export interface DemoKnowledgeDocument {
  title: string;
  text: string;
  /** Printed next to the title in the reply's "Sources:" footer, so it is a plain name, never an id. */
  sourceLabel: string;
}

export interface DemoPersona {
  /** Starts with the demo id prefix, which is how reset finds it. */
  id: string;
  content: PersonaContent;
  knowledge: DemoKnowledgeDocument[];
}

/** A page in the user's Spaces view; `id` starts with the demo id prefix. */
export interface DemoSpace {
  id: string;
  content: SpaceContent;
}

export interface DemoWorld {
  /** The seeded day (`YYYY-MM-DD` in the user's zone); a changed day means the dated content is stale. */
  day: string;
  /** The zone that defines the seed day. */
  timeZone: string;
  personas: DemoPersona[];
  profile: PersonalizationProfileContent;
  notes: DemoNote[];
  spaces: DemoSpace[];
  agentDescription: string;
  agentSpec: AgentSpec;
  scheduleManifest: ScheduleManifest;
}
