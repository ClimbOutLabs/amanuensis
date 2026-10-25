'use client';

import type { FC } from 'react';

import { HELP_AREA_IDS, type HelpAreaId } from '@truefoundry/trueforge-core/schemas/personalizationHelpAreas';

import { HELP_AREA_TOPIC, HOME_TOPIC_IDS, HOME_TOPICS, type HomeTopicId } from './tourPrompts.js';

/** The pills that a saved help area leads to, in the order the home shows them. */
const CHOICE_TOPIC_IDS = HOME_TOPIC_IDS.filter(topic => HELP_AREA_IDS.some(id => HELP_AREA_TOPIC[id] === topic));

/**
 * Turns a pill on by adding its first help area at the end, and off by removing every area that leads to it,
 * so two areas on one pill never leave it half on. The list keeps the order chosen.
 */
export function toggleHelpAreaTopic(current: readonly HelpAreaId[], topic: HomeTopicId): HelpAreaId[] {
  if (current.some(id => HELP_AREA_TOPIC[id] === topic)) return current.filter(id => HELP_AREA_TOPIC[id] !== topic);
  const first = HELP_AREA_IDS.find(id => HELP_AREA_TOPIC[id] === topic);
  return first === undefined ? [...current] : [...current, first];
}

/** "What would help you most?": the Tour's card choice, shared by the setup card and Settings. */
export const HelpAreaChoices: FC<{
  idPrefix: string;
  value: readonly HelpAreaId[];
  onChange: (next: HelpAreaId[]) => void;
  disabled?: boolean;
}> = ({ idPrefix, value, onChange, disabled = false }) => (
  <fieldset className="min-w-0 border-0 p-0">
    <legend className="text-sm font-medium text-text-primary">What would help you most?</legend>
    <p className="mt-1 text-sm text-text-secondary">
      Pick any, and change them any time. They show as pills on the home.
    </p>
    <div className="mt-3 grid gap-2 sm:grid-cols-2">
      {CHOICE_TOPIC_IDS.map(topic => (
        <label
          key={topic}
          className="flex items-start gap-2 rounded-lg border border-border/70 bg-secondary-bg px-3 py-2 text-sm text-text-primary"
        >
          <input
            id={`${idPrefix}-${topic}`}
            type="checkbox"
            className="mt-0.5"
            checked={value.some(id => HELP_AREA_TOPIC[id] === topic)}
            disabled={disabled}
            onChange={() => onChange(toggleHelpAreaTopic(value, topic))}
          />
          <span>{HOME_TOPICS[topic].label}</span>
        </label>
      ))}
    </div>
  </fieldset>
);
