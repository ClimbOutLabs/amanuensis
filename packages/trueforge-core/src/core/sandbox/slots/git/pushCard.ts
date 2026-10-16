import type { HostGitPushPreview } from '../../provider/Provider';

/** The approval card fields for a push, from what the host itself worked out. */
export interface PushCardFields {
  plain_what: string;
  cannot_be_undone: string | null;
  destination: string;
  parsed_command: string;
}

const SHOWN_COMMITS = 10;

export function pushCardFields(input: { preview: HostGitPushPreview; command: string }): PushCardFields {
  const { preview } = input;
  const count = preview.commit_count;
  const noun = `${String(count)} commit${count === 1 ? '' : 's'}`;
  const shown = preview.commits.slice(0, SHOWN_COMMITS).map(commit => `  ${commit.sha.slice(0, 7)} ${commit.subject}`);
  const more = count > shown.length ? [`  and ${String(count - shown.length)} more`] : [];
  return {
    plain_what: preview.dry_run
      ? `Check what pushing ${noun} to the ${preview.branch} branch of ${preview.repository} would send. Nothing is sent.`
      : `Push ${noun} to the ${preview.branch} branch of ${preview.repository} on GitHub.`,
    cannot_be_undone: preview.dry_run ? null : "Once this is sent, it can't be unsent.",
    destination: `github.com/${preview.repository} (branch ${preview.branch})`,
    parsed_command: [input.command, '', `Commits (${noun}):`, ...shown, ...more].join('\n'),
  };
}
