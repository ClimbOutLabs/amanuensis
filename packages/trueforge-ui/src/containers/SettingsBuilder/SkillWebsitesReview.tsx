'use client';

import type { FC } from 'react';

import {
  SKILL_SITES_DATA_WARNING,
  SKILL_SITES_SEND_WARNING,
  type SkillWebsiteCheck,
} from '../../server/skillNetworkApproval.js';

/**
 * The websites a skill sends requests to, shown before it is added. Adding it allows exactly
 * these, so the same warnings as the network approval are in view.
 */
export const SkillWebsitesReview: FC<{ check: SkillWebsiteCheck }> = ({ check }) => (
  <div className="space-y-2 rounded border border-border bg-primary-bg px-3 py-2 text-sm" data-role="skill-websites">
    {check.websites.length === 0 ? (
      <p className="text-text-primary">It doesn&apos;t send requests to any website.</p>
    ) : (
      <>
        <p className="text-text-primary">It sends requests to these websites:</p>
        <ul className="list-disc pl-5 text-text-primary">
          {check.websites.map(site => (
            <li key={site} className="break-words">
              {site}
            </li>
          ))}
        </ul>
        <p className="text-text-primary">
          Adding it lets the skill reach these websites and no others. {SKILL_SITES_DATA_WARNING}
        </p>
        {check.canSend && <p className="font-semibold text-text-primary">{SKILL_SITES_SEND_WARNING}</p>}
      </>
    )}
    {check.makesUpAddresses && (
      <p className="text-text-secondary">
        Aman also found code that makes up web addresses while it runs. Those websites stay blocked, and you&apos;ll be
        asked about each one.
      </p>
    )}
  </div>
);

/** The add button's words: it says the websites are allowed too, when there are any. */
export function addSkillLabel(check: SkillWebsiteCheck): string {
  return check.websites.length === 0 ? 'Add skill' : 'Add skill and allow websites';
}
