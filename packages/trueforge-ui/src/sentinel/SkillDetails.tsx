'use client';

import type { FC } from 'react';

import type { SentinelApprovalSkill } from './types.js';

function Line({ label, value }: { label: string; value: string }) {
  return (
    <p className="break-words text-text-primary">
      <span className="text-text-secondary">{label}: </span>
      {value}
    </p>
  );
}

/**
 * The skill a chat call adds. Where it comes from and its exact version are always in view, because a
 * skill is instructions written by someone else. Its own instruction file sits under Details.
 */
export const SkillDetails: FC<{ skill: SentinelApprovalSkill }> = ({ skill }) => (
  <div className="space-y-3 rounded border border-border bg-primary-bg px-3 py-2" data-role="skill">
    <div>
      <Line label="Name" value={skill.name} />
      <Line label="For" value={skill.description} />
      <Line label="From" value={skill.source} />
      <Line label="Version" value={skill.version} />
    </div>
    <p className="text-text-secondary">
      {skill.starter
        ? 'This is one of the starter skills that come with the app.'
        : 'This skill was written by someone else. Add it only if you trust where it comes from.'}{' '}
      It may bring files and scripts along. Running code still asks you first, as always.
    </p>
    <div data-role="skill-websites">
      {skill.websites.length === 0 ? (
        <p className="text-text-primary">It doesn&apos;t send requests to any website.</p>
      ) : (
        <>
          <p className="text-text-primary">It sends requests to these websites:</p>
          <ul className="list-disc pl-5 text-text-primary">
            {skill.websites.map(site => (
              <li key={site} className="break-words">
                {site}
              </li>
            ))}
          </ul>
          <p className="text-text-primary">Adding it lets the skill reach these websites and no others.</p>
        </>
      )}
      {skill.makes_up_addresses && (
        <p className="mt-2 text-text-secondary">
          Aman also found code that makes up web addresses while it runs. Those websites stay blocked, and you&apos;ll
          be asked about each one.
        </p>
      )}
    </div>
    {skill.instructions !== null && (
      <details>
        <summary className="cursor-pointer text-text-secondary">Details</summary>
        <div
          role="region"
          aria-label="Skill instructions"
          tabIndex={0}
          className="mt-2 max-h-60 overflow-auto rounded border border-border bg-card-bg px-3 py-2"
        >
          <p className="whitespace-pre-wrap break-words text-text-primary">{skill.instructions}</p>
        </div>
      </details>
    )}
  </div>
);
