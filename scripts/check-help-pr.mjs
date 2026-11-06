#!/usr/bin/env node
// Fails a pull request that changes a screen people see but not the help that explains it.
// Run by `pnpm help:pr-check` in the "Help guide changed with screens" workflow.
//
// A reviewer can wave it through with the `help: no change needed` label; the pull request then
// says in a line why no topic changes. The label is honoured, the line is what the reviewer reads.

import { execFile } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

export const NO_CHANGE_LABEL = 'help: no change needed';

export const SCREEN_CHANGE_MESSAGE = `This change touches a screen people see. Update the help topic that covers it, or add the label \`${NO_CHANGE_LABEL}\` with a line in the PR saying why.`;

/** True for a file whose change can change what a person sees or reads. */
export function isScreenFile(file) {
  return (
    file.startsWith('packages/trueforge-ui/src/containers/') ||
    file.startsWith('packages/trueforge-ui/src/atoms/') ||
    file.startsWith('packages/frontend/src/') ||
    file.startsWith('packages/trueforge/src/routes/') ||
    file === 'packages/aman-installer/src/messages.ts' ||
    /^installer\/lib\/[^/]+\.sh$/.test(file)
  );
}

/** True for a file that is the help itself: a topic page or the Tour cards. */
export function isGuideFile(file) {
  return (
    file.startsWith('packages/trueforge/guide/topics/') ||
    file === 'packages/trueforge-ui/src/components/tourPrompts.ts'
  );
}

/**
 * Decides the check from the pull request's changed files and labels. Returns the screen files
 * that triggered it, so the failure can name them.
 */
export function checkHelpPr({ changedFiles, labels }) {
  const screenFiles = changedFiles.filter(isScreenFile);
  if (screenFiles.length === 0 || changedFiles.some(isGuideFile) || labels.includes(NO_CHANGE_LABEL)) {
    return { ok: true, screenFiles };
  }
  return { ok: false, screenFiles };
}

function parseLabels(text) {
  if (text === undefined || text.trim() === '') {
    return [];
  }
  const parsed = JSON.parse(text);
  if (!Array.isArray(parsed) || !parsed.every(item => typeof item === 'string')) {
    throw new Error(
      'HELP_PR_LABELS must be a JSON list of label names. Pass toJSON(github.event.pull_request.labels.*.name).',
    );
  }
  return parsed;
}

async function changedFilesSince(baseSha) {
  const { stdout } = await promisify(execFile)('git', ['diff', '--name-only', `${baseSha}...HEAD`], {
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout.split('\n').filter(line => line !== '');
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const baseSha = process.env.HELP_PR_BASE_SHA;
  if (baseSha === undefined || baseSha === '') {
    console.error('HELP_PR_BASE_SHA is not set. Set it to the pull request base commit, then run this again.');
    process.exitCode = 1;
  } else {
    changedFilesSince(baseSha)
      .then(changedFiles => {
        const result = checkHelpPr({ changedFiles, labels: parseLabels(process.env.HELP_PR_LABELS) });
        if (result.ok) {
          console.log('Help check for this pull request: nothing to update, or the help changed with the screens.');
          return;
        }
        console.error(SCREEN_CHANGE_MESSAGE);
        console.error(`Screen files changed: ${result.screenFiles.join(', ')}`);
        process.exitCode = 1;
      })
      .catch(error => {
        console.error(error);
        process.exitCode = 1;
      });
  }
}
