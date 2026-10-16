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

/** What the pre-baked briefing chat shows, in the order the turn runs. */
export interface DemoBriefing {
  title: string;
  userText: string;
  /** The assistant's line before it calls the route tool. */
  routeIntro: string;
  routeArguments: { from_place: string; to_place: string };
  routeResult: {
    from: { resolved_name: string; lat: number; lng: number };
    to: { resolved_name: string; lat: number; lng: number };
    distance_km: number;
    duration_min: number;
    route_geometry: string;
    attribution: string;
  };
  finalText: string;
}

export interface DemoWorld {
  /** The seeded day (`YYYY-MM-DD` in the user's zone); a changed day means the dated content is stale. */
  day: string;
  personas: DemoPersona[];
  profile: PersonalizationProfileContent;
  notes: DemoNote[];
  spaces: DemoSpace[];
  agentDescription: string;
  agentSpec: AgentSpec;
  scheduleManifest: ScheduleManifest;
  briefing: DemoBriefing;
}
