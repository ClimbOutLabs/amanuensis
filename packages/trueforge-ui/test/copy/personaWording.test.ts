import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

import { describe, expect, it } from 'vitest';

import { packageRoot, sourceFiles } from '../packageSources.js';

// Screens about personas: who answers a chat and keeps its own notes. Agents run schedules.
const PERSONA_SCREENS = [
  'src/atoms/ActivePersonaIndicator.tsx',
  'src/atoms/memory/MemorySharing.tsx',
  'src/atoms/memory/MemoryVaultPanels.tsx',
  'src/components/PersonaContext.tsx',
  'src/containers/SettingsBuilder/PersonaKnowledge.tsx',
  'src/containers/SettingsBuilder/PersonaSettings.tsx',
  'src/sentinel/PersonaDetails.tsx',
];

/** Source with comments and import lines removed, so only code and the words people read remain. */
function codeOf(path: string): string {
  return readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/^import[^;]*;/gms, '');
}

describe('persona wording', () => {
  const root = packageRoot();

  it('never says "specialist" anywhere in the UI', () => {
    const offenders = sourceFiles(join(root, 'src'))
      .filter(path => /specialist/i.test(readFileSync(path, 'utf8')))
      .map(path => relative(root, path));
    expect(offenders).toEqual([]);
  });

  it('never says "agent" on a persona screen', () => {
    const offenders = PERSONA_SCREENS.filter(path => /\bagents?\b/i.test(codeOf(join(root, path))));
    expect(offenders).toEqual([]);
  });

  it('never says "agent" in the words the held action and approval cards show', () => {
    const offenders = sourceFiles(join(root, 'src/sentinel'))
      .filter(path => /\bagents?\b/i.test(codeOf(path)))
      .map(path => relative(root, path));
    expect(offenders).toEqual([]);
  });

  it('never calls the chat persona an agent in the grant hints or the always allow confirm steps', () => {
    const grantCopy = [
      'src/sentinel/approvalChoices.ts',
      'src/sentinel/HeldActionCard.tsx',
      'src/sentinel/PermissionApprovalCard.tsx',
    ];
    const offenders = grantCopy.filter(path =>
      /the agent will|ask the agent/i.test(readFileSync(join(root, path), 'utf8')),
    );
    expect(offenders).toEqual([]);
  });
});
