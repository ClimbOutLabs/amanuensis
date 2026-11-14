'use client';

import type { FC } from 'react';

import { Icon } from '../icons/Icon.js';
import { SKILL_SITES_DATA_WARNING, SKILL_SITES_SEND_WARNING } from '../server/skillNetworkApproval.js';
import type { SentinelApprovalSkill } from './types.js';

/** A commit is long; the first seven characters are enough to tell versions apart at a glance. */
const SHORT_VERSION_LENGTH = 7;

function shortVersion(version: string): string {
  return /^[0-9a-f]{40}$/.test(version) ? version.slice(0, SHORT_VERSION_LENGTH) : version;
}

function SkillWebsites({ skill }: { skill: SentinelApprovalSkill }) {
  return (
    <div className="space-y-2" data-role="skill-websites">
      {skill.websites.length === 0 ? (
        <p className="text-text-primary">It doesn&apos;t send requests to any website.</p>
      ) : (
        <div className="space-y-2 rounded-lg border border-border bg-primary-bg px-3 py-2.5">
          <p className="font-medium text-text-primary">It sends requests to these websites</p>
          <ul className="flex flex-wrap gap-1.5" aria-label="Websites">
            {skill.websites.map(site => (
              <li
                key={site}
                className="break-all rounded-full border border-border bg-card-bg px-2.5 py-0.5 text-sm text-text-primary"
              >
                {site}
              </li>
            ))}
          </ul>
          <p className="text-sm text-text-secondary">
            Adding it lets the skill reach these websites and no others. {SKILL_SITES_DATA_WARNING}
          </p>
        </div>
      )}
      {skill.can_send && (
        <p
          className="flex items-start gap-2 rounded-lg border border-warning-bg/40 bg-warning-bg/10 px-3 py-2.5 font-medium text-text-primary"
          role="note"
        >
          <Icon name="triangle-exclamation" className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <span>{SKILL_SITES_SEND_WARNING}</span>
        </p>
      )}
      {skill.makes_up_addresses && (
        <p className="text-sm text-text-secondary">
          Aman also found code that makes up web addresses while it runs. Those websites stay blocked, and you&apos;ll
          be asked about each one.
        </p>
      )}
    </div>
  );
}

/**
 * The skill a chat call adds. What it is for, where it comes from and which websites it reaches stay in view,
 * because a skill is instructions written by someone else. Its exact version and own instructions sit under
 * Details.
 */
export const SkillDetails: FC<{ skill: SentinelApprovalSkill }> = ({ skill }) => (
  <div className="space-y-3" data-role="skill">
    <div className="space-y-1">
      <p className="break-words text-text-primary">{skill.description}</p>
      <p className="flex items-start gap-1.5 break-words text-sm text-text-secondary">
        <Icon name="github" className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
        <span>
          {skill.source} · version {shortVersion(skill.version)}
        </span>
      </p>
      <p className="text-sm text-text-secondary">
        {skill.starter
          ? 'One of the starter skills that come with the app.'
          : 'Written by someone else. Add it only if you trust where it comes from.'}{' '}
        Running its code still asks you first.
      </p>
    </div>
    <SkillWebsites skill={skill} />
    <details>
      <summary className="cursor-pointer text-sm text-text-secondary">Details</summary>
      <div className="mt-2 space-y-2 text-sm">
        <p className="break-all text-text-secondary">
          Exact version: <span className="font-mono text-text-primary">{skill.version}</span>
        </p>
        {skill.instructions !== null && (
          <div
            role="region"
            aria-label="Skill instructions"
            tabIndex={0}
            className="max-h-60 overflow-auto rounded border border-border bg-card-bg px-3 py-2"
          >
            <p className="whitespace-pre-wrap break-words text-text-primary">{skill.instructions}</p>
          </div>
        )}
      </div>
    </details>
  </div>
);
