'use client';

import {
  SKILL_SITES_DATA_WARNING,
  SKILL_SITES_SEND_WARNING,
} from '@truefoundry/trueforge-core/core/permissions/skillSitesCopy';
import type { FC, ReactNode } from 'react';

import { Icon } from '../icons/Icon.js';
import type { SentinelApprovalSkill } from './types.js';

/** A commit is long; the first seven characters are enough to tell versions apart at a glance. */
const SHORT_VERSION_LENGTH = 7;

function shortVersion(version: string): string {
  return /^[0-9a-f]{40}$/.test(version) ? version.slice(0, SHORT_VERSION_LENGTH) : version;
}

/** Labelled parts read top to bottom, so the card is scanned rather than read as one block. */
function Section({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section className="space-y-1.5 border-t border-border pt-4 first:border-t-0 first:pt-0">
      <h4 className="text-xs font-semibold uppercase tracking-wide text-text-secondary">{label}</h4>
      {children}
    </section>
  );
}

function SkillWebsites({ skill }: { skill: SentinelApprovalSkill }) {
  return (
    <div className="space-y-2" data-role="skill-websites">
      {skill.websites.length === 0 ? (
        <p className="text-text-primary">None. It doesn&apos;t send requests to any website.</p>
      ) : (
        <>
          <ul className="space-y-1" aria-label="Websites">
            {skill.websites.map(site => (
              <li key={site} className="flex items-center gap-2 break-all text-text-primary">
                <span className="size-1.5 shrink-0 rounded-full bg-text-secondary" aria-hidden="true" />
                {site}
              </li>
            ))}
          </ul>
          <p className="text-sm text-text-secondary">
            Adding it lets the skill reach these websites and no others. {SKILL_SITES_DATA_WARNING}
          </p>
        </>
      )}
      {skill.can_send && (
        <p className="flex items-start gap-2 rounded-lg bg-warning-bg/10 px-3 py-2.5 text-text-primary" role="note">
          <Icon name="triangle-exclamation" className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <span>{SKILL_SITES_SEND_WARNING}</span>
        </p>
      )}
      {skill.makes_up_addresses && (
        <p className="text-sm text-text-secondary">
          It also makes up some web addresses while it runs. Those stay blocked, and you&apos;ll be asked about each
          one.
        </p>
      )}
    </div>
  );
}

/**
 * The skill a chat call adds. What it is for, which websites it reaches and where it comes from stay in view,
 * because a skill is instructions written by someone else. Its exact version and own instructions sit under
 * Details.
 */
export const SkillDetails: FC<{ skill: SentinelApprovalSkill }> = ({ skill }) => (
  <div className="space-y-4 py-1" data-role="skill">
    <Section label="What it does">
      <p className="break-words text-base text-text-primary">{skill.description}</p>
      <p className="text-sm text-text-secondary">
        {skill.starter
          ? 'A starter skill that comes with Aman.'
          : 'Written by someone else. Add it only if you trust where it comes from.'}{' '}
        Running its code still asks you first.
      </p>
    </Section>
    <Section label="Websites it can reach">
      <SkillWebsites skill={skill} />
    </Section>
    <Section label="Where it comes from">
      <p className="break-words text-sm text-text-primary">
        {skill.source} · version {shortVersion(skill.version)}
      </p>
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
    </Section>
  </div>
);
