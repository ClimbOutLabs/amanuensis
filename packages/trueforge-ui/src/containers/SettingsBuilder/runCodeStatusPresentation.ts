import type { RunCodeStatus } from '@/components/RunCodeStatusContext.js';

export type StatusTone = 'success' | 'warning' | 'failure' | 'neutral';

/** One row of the Image card. New health rows append to `checks`; the card needs no change. */
export interface Check {
  label: string;
  text: string;
  tone: StatusTone;
}

export interface RunCodeStatusPresentation {
  tone: StatusTone;
  /** Short pill label next to the status dot. */
  pill: string;
  headline: string;
  summary: string;
  /** What the admin should do; absent when nothing is needed. */
  fix?: string;
  /** Server setting names behind this state, shown under Technical details rather than in the advice. */
  settings?: string;
  checks: Check[];
}

const NOT_CHECKED: { text: string; tone: StatusTone } = { text: 'Not checked', tone: 'neutral' };

function download(result: { text: string; tone: StatusTone }): Check {
  return { label: 'Download', ...result };
}

function signature(result: { text: string; tone: StatusTone }): Check {
  return { label: 'Signature', ...result };
}

const DOWNLOADED = download({ text: 'Downloaded', tone: 'success' });
const VERIFIED = signature({ text: 'Verified', tone: 'success' });

export function presentRunCodeStatus(status: RunCodeStatus): RunCodeStatusPresentation {
  switch (status.state) {
    case 'ready':
      return {
        tone: 'success',
        pill: 'Ready',
        headline: 'Code execution is on',
        summary:
          'The assistant can run Python and Node.js code. Each run starts in a fresh Docker container with no network access.',
        checks: [DOWNLOADED, VERIFIED],
      };
    case 'not_configured':
      return {
        tone: 'neutral',
        pill: 'Off',
        headline: 'Code execution is off: no sandbox image is configured',
        summary: 'This server has not been given a sandbox image, so the assistant cannot run code.',
        fix: "Ask whoever runs this server to set up this release's signed sandbox image, then restart the server.",
        settings: 'SANDBOX_IMAGE, SANDBOX_COSIGN_PUBLIC_KEY_PATH',
        checks: [download({ text: 'Not configured', tone: 'neutral' }), signature(NOT_CHECKED)],
      };
    case 'docker_unavailable':
      return {
        tone: 'failure',
        pill: 'Off',
        headline: 'Code execution is off: Docker is not available to the server',
        summary:
          'The server could not find Docker, so it cannot start a sandbox. This is common when the server itself runs in a container.',
        fix: "Install Docker on the machine that runs the server, or, if the server runs in a container, give that container access to the host's Docker socket. Then restart the server and re-check.",
        checks: [],
      };
    case 'daemon_unavailable':
      return {
        tone: 'failure',
        pill: 'Off',
        headline: 'Code execution is off: Docker is not responding',
        summary: 'Docker is installed, but the server could not use it to start a sandbox.',
        fix: "Start or restart the Docker daemon and make sure the server's user is allowed to use it, then re-check.",
        checks: [],
      };
    case 'image_missing':
      return {
        tone: 'warning',
        pill: 'Setting up',
        headline: 'Sandbox image not downloaded yet',
        summary:
          'The image is downloaded automatically the first time the assistant runs code. That can take a few minutes and needs internet access.',
        fix: 'Nothing to do yet. Ask the assistant to run some code, then re-check.',
        checks: [
          download({ text: 'Not downloaded yet', tone: 'warning' }),
          signature({ text: 'Checked after the download', tone: 'neutral' }),
        ],
      };
    case 'signature_unverified':
      return {
        tone: 'failure',
        pill: 'Off',
        headline: "Code execution is off: the sandbox image's signature could not be verified",
        summary: 'The server will not run an image it cannot confirm came from this release.',
        fix: 'Restart the server with internet access so it can fetch the signature. If it still fails, delete the image and let the server download it again.',
        settings: 'SANDBOX_COSIGN_PUBLIC_KEY_PATH',
        checks: [DOWNLOADED, signature({ text: 'Not verified', tone: 'failure' })],
      };
    case 'image_unavailable':
      return {
        tone: 'failure',
        pill: 'Off',
        headline: 'Code execution is off: the sandbox image does not match this release',
        summary: 'The image found on this machine is not the one the server is configured to use.',
        fix: 'Make sure the server is set to use the exact image for this release, remove old copies of the image, and restart the server.',
        settings: 'SANDBOX_IMAGE',
        checks: [download({ text: 'Does not match', tone: 'failure' }), signature(NOT_CHECKED)],
      };
    case 'isolation_refused':
      return {
        tone: 'failure',
        pill: 'Off',
        headline: 'Code execution is off: the sandbox could not apply its safety limits',
        summary:
          'The server tested a sandbox and found that one of its protections, such as no network access, was not in place. It refuses to run code that way.',
        fix: 'Update Docker and check that its security features are not disabled, then re-check.',
        checks: [DOWNLOADED, VERIFIED],
      };
    case 'unsupported_platform':
      return {
        tone: 'failure',
        pill: 'Off',
        headline: "Code execution is off: this server's system is not supported",
        summary: 'The Docker sandbox needs a Linux host.',
        fix: 'Run the server on Linux, or in a Linux container.',
        checks: [],
      };
  }
}

/** Whole GB when the value divides evenly, MB otherwise. */
export function formatMegabytes(mb: number): string {
  return mb >= 1024 && mb % 1024 === 0 ? `${String(mb / 1024)} GB` : `${String(mb)} MB`;
}

/** Whole minutes when the value divides evenly, seconds otherwise. */
export function formatSeconds(seconds: number): string {
  return seconds >= 60 && seconds % 60 === 0 ? `${String(seconds / 60)} min` : `${String(seconds)} s`;
}

/** The last path segment and tag of an image reference, without its digest: `name 1.2.3`. */
export function shortImageName(reference: string): string {
  const withoutDigest = reference.split('@')[0] ?? reference;
  const last = withoutDigest.split('/').pop() ?? withoutDigest;
  const colon = last.lastIndexOf(':');
  return colon === -1 ? last : `${last.slice(0, colon)} ${last.slice(colon + 1)}`;
}

/** "just now" under a minute, then whole minutes, then whole hours. */
export function formatCheckedAgo({ checkedAt, now }: { checkedAt: number; now: number }): string {
  const minutes = Math.floor(Math.max(0, now - checkedAt) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${String(minutes)} min ago`;
  return `${String(Math.floor(minutes / 60))} h ago`;
}
