// Used only on the fresh runner's disposable instance. Its temporary data directory owns cleanup.
import { randomBytes } from 'node:crypto';
import { seedSpace } from '../eval-tokens/space.mjs';

/** @returns {Promise<import('./parse.mjs').ModelCase[]>} */
export async function seedProductCases(client) {
  const goalCode = randomBytes(6).toString('hex');
  const spaceCode = randomBytes(6).toString('hex');
  const goalTitle = 'Workshop inspection';
  const spaceName = 'Exhibit opening';
  await client.createGoalDraft({ title: goalTitle, outcome: `Obtain workshop certificate ${goalCode}.` });
  await seedSpace({
    client,
    content: {
      name: spaceName,
      purpose: 'Keep the exhibit arrangements together.',
      status: 'active',
      format: 'markdown',
      body: `The exhibit confirmation code is ${spaceCode}.`,
    },
  });
  return [
    {
      id: 'weekly-read-goal',
      group: 'goals',
      prompt: `Read my goal called "${goalTitle}". What certificate code does its outcome mention?`,
      incognito: true,
      approval_policy: 'decline',
      checks: [
        { type: 'tool_called', tools: ['get_goal'] },
        { type: 'reply_includes', any: [goalCode] },
      ],
      checklist: [],
    },
    {
      id: 'weekly-read-space',
      group: 'spaces',
      prompt: `Read the body of my "${spaceName}" Space and give me its confirmation code.`,
      incognito: true,
      approval_policy: 'decline',
      checks: [
        { type: 'tool_called', tools: ['get_space'] },
        { type: 'reply_includes', any: [spaceCode] },
      ],
      checklist: [],
    },
  ];
}
