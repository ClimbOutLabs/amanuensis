import type { RunCodeStatus } from '@/components/RunCodeStatusContext.js';

export type StatusTone = 'success' | 'warning' | 'failure' | 'neutral';

export interface Check {
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
  image: Check;
  signature: Check;
}

const NOT_CHECKED: Check = { text: 'Not checked', tone: 'neutral' };
const NOT_CONFIRMED: Check = { text: "Can't be checked without Docker", tone: 'neutral' };
const DOWNLOADED: Check = { text: 'Downloaded', tone: 'success' };
const VERIFIED: Check = { text: 'Verified', tone: 'success' };

export function presentRunCodeStatus(status: RunCodeStatus): RunCodeStatusPresentation {
  switch (status.state) {
    case 'ready':
      return {
        tone: 'success',
        pill: 'Ready',
        headline: 'Code execution is on',
        summary:
          'The assistant can run Python and Node.js code. Each run starts in a fresh Docker container with no network access.',
        image: DOWNLOADED,
        signature: VERIFIED,
      };
    case 'not_configured':
      return {
        tone: 'neutral',
        pill: 'Off',
        headline: 'Code execution is off: no sandbox image is configured',
        summary: 'This server has not been given a sandbox image, so the assistant cannot run code.',
        fix: "Set SANDBOX_IMAGE to this release's signed image and SANDBOX_COSIGN_PUBLIC_KEY_PATH to its public key, then restart the server.",
        image: { text: 'Not configured', tone: 'neutral' },
        signature: NOT_CHECKED,
      };
    case 'docker_unavailable':
      return {
        tone: 'failure',
        pill: 'Off',
        headline: 'Code execution is off: Docker is not available to the server',
        summary:
          'The server could not find Docker, so it cannot start a sandbox. This is common when the server itself runs in a container.',
        fix: "Install Docker on the machine that runs the server, or, if the server runs in a container, give that container access to the host's Docker socket. Then restart the server and re-check.",
        image: NOT_CONFIRMED,
        signature: NOT_CONFIRMED,
      };
    case 'daemon_unavailable':
      return {
        tone: 'failure',
        pill: 'Off',
        headline: 'Code execution is off: Docker is not responding',
        summary: 'Docker is installed, but the server could not use it to start a sandbox.',
        fix: "Start or restart the Docker daemon and make sure the server's user is allowed to use it, then re-check.",
        image: NOT_CONFIRMED,
        signature: NOT_CONFIRMED,
      };
    case 'image_missing':
      return {
        tone: 'warning',
        pill: 'Setting up',
        headline: 'Sandbox image not downloaded yet',
        summary:
          'The image is downloaded automatically the first time the assistant runs code. That can take a few minutes and needs internet access.',
        fix: 'Nothing to do yet. Ask the assistant to run some code, then re-check.',
        image: { text: 'Not downloaded yet', tone: 'warning' },
        signature: { text: 'Checked after the download', tone: 'neutral' },
      };
    case 'signature_unverified':
      return {
        tone: 'failure',
        pill: 'Off',
        headline: "Code execution is off: the sandbox image's signature could not be verified",
        summary: 'The server will not run an image it cannot confirm came from this release.',
        fix: "Make sure the server can reach the image registry once, and that SANDBOX_COSIGN_PUBLIC_KEY_PATH points to this release's public key. If it keeps failing, replace the image with the one from this release.",
        image: DOWNLOADED,
        signature: { text: 'Not verified', tone: 'failure' },
      };
    case 'image_unavailable':
      return {
        tone: 'failure',
        pill: 'Off',
        headline: 'Code execution is off: the sandbox image does not match this release',
        summary: 'The image found on this machine is not the one the server is configured to use.',
        fix: 'Check that SANDBOX_IMAGE names the exact image for this release (name@sha256:...), remove stale copies of the image, and restart the server.',
        image: { text: 'Does not match', tone: 'failure' },
        signature: NOT_CHECKED,
      };
    case 'isolation_refused':
      return {
        tone: 'failure',
        pill: 'Off',
        headline: 'Code execution is off: the sandbox could not apply its safety limits',
        summary:
          'The server tested a sandbox and found that one of its protections, such as no network access, was not in place. It refuses to run code that way.',
        fix: 'Update Docker and check that its security features are not disabled, then re-check.',
        image: DOWNLOADED,
        signature: VERIFIED,
      };
    case 'unsupported_platform':
      return {
        tone: 'failure',
        pill: 'Off',
        headline: "Code execution is off: this server's system is not supported",
        summary: 'The Docker sandbox needs a Linux host.',
        fix: 'Run the server on Linux, or in a Linux container.',
        image: NOT_CHECKED,
        signature: NOT_CHECKED,
      };
  }
}

/** Whole GiB when the value divides evenly, MiB otherwise. */
export function formatMebibytes(mib: number): string {
  return mib >= 1024 && mib % 1024 === 0 ? `${String(mib / 1024)} GiB` : `${String(mib)} MiB`;
}

/** Whole minutes when the value divides evenly, seconds otherwise. */
export function formatSeconds(seconds: number): string {
  return seconds >= 60 && seconds % 60 === 0 ? `${String(seconds / 60)} min` : `${String(seconds)} s`;
}
