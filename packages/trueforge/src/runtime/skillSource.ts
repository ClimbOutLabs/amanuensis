/**
 * Read-only lookups of a skill where it is published, for adding a skill from a chat. The host reads
 * the skill itself, so the name and description on the approval card are the skill's own and not the
 * model's words. Only public GitHub repositories are read, and nothing here writes anywhere.
 */
import { parse } from 'yaml';

/** A SKILL.md larger than this is refused: it could not be shown in full on the card. */
export const MAX_SKILL_FILE_BYTES = 100 * 1024;

const FULL_COMMIT = /^[0-9a-f]{40}$/;

export type SkillSourceProblem =
  'not_github' | 'not_found' | 'no_skill_file' | 'unreadable_skill_file' | 'too_large' | 'rate_limited' | 'unavailable';

const PROBLEM_MESSAGES: Record<SkillSourceProblem, string> = {
  not_github:
    'Nothing was added because only skills in a public GitHub repository can be added from a chat. Tell the user to add this one in Settings, under Skills.',
  not_found:
    'Nothing was added because that repository, branch or version could not be found on GitHub. Check the address with the user and try again.',
  no_skill_file:
    'Nothing was added because there is no SKILL.md file in that folder. Ask the user which folder of the repository holds the skill, then try again.',
  unreadable_skill_file:
    'Nothing was added because the SKILL.md file does not start with a name and a description. Tell the user this skill cannot be added until its author fixes that.',
  too_large:
    'Nothing was added because the SKILL.md file is too large to show in full. Tell the user to add this skill in Settings, under Skills.',
  rate_limited:
    'Nothing was added because GitHub is refusing more lookups for now. Tell the user to try again in an hour.',
  unavailable:
    'Nothing was added because GitHub could not be reached. Tell the user to check the connection and try again.',
};

export class SkillSourceError extends Error {
  readonly problem: SkillSourceProblem;

  constructor(problem: SkillSourceProblem, options?: ErrorOptions) {
    super(PROBLEM_MESSAGES[problem], options);
    this.name = 'SkillSourceError';
    this.problem = problem;
  }
}

/** Where a skill lives, as the person or the model wrote it. */
export interface SkillAddress {
  owner: string;
  repo: string;
  /** Folder that holds SKILL.md; undefined for the top of the repository. */
  path: string | undefined;
  /** Branch, tag or commit; undefined for the repository's main branch. */
  ref: string | undefined;
}

/**
 * Reads a GitHub address into its parts. Takes the plain repository address, and also the address of
 * a folder or of the SKILL.md file as the browser shows it (`/tree/<branch>/<folder>`), because that is
 * what people copy. A branch name with a slash in it cannot be told apart from a folder that way, so
 * the first part after `/tree/` is taken as the branch.
 */
export function parseSkillAddress(address: string): SkillAddress | undefined {
  let url: URL;
  try {
    url = new URL(address.trim());
  } catch {
    return undefined;
  }
  if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== 'github.com' || url.port !== '') {
    return undefined;
  }
  if (url.username !== '' || url.password !== '') {
    return undefined;
  }
  let parts: string[];
  try {
    parts = url.pathname
      .split('/')
      .filter(part => part.length > 0)
      .map(part => decodeURIComponent(part));
  } catch {
    return undefined;
  }
  const [owner, rawRepo, kind, ref, ...rest] = parts;
  const repo = rawRepo?.replace(/\.git$/i, '');
  if (owner === undefined || repo === undefined || repo.length === 0) {
    return undefined;
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(owner) || !/^[A-Za-z0-9._-]+$/.test(repo) || repo === '.' || repo === '..') {
    return undefined;
  }
  if (kind === undefined) {
    return { owner, repo, path: undefined, ref: undefined };
  }
  if ((kind !== 'tree' && kind !== 'blob') || ref === undefined) {
    return undefined;
  }
  const folder = kind === 'blob' && rest.at(-1)?.toUpperCase() === 'SKILL.MD' ? rest.slice(0, -1) : rest;
  return { owner, repo, path: folder.length === 0 ? undefined : folder.join('/'), ref };
}

/** A skill as the host read it from GitHub at one exact commit. */
export interface PublishedSkill {
  /** The full commit the skill was read at. */
  commit: string;
  /** The name the skill gives itself; undefined when its file names none. */
  name: string | undefined;
  description: string;
  /** The whole SKILL.md body after its opening block. */
  instructions: string;
}

function encodePath(path: string): string {
  return path
    .split('/')
    .filter(part => part.length > 0)
    .map(part => encodeURIComponent(part))
    .join('/');
}

async function githubGet(input: { path: string; accept: string; fetchImpl: typeof fetch }): Promise<Response> {
  let response: Response;
  try {
    response = await input.fetchImpl(`https://api.github.com${input.path}`, {
      headers: { accept: input.accept, 'user-agent': 'amanuensis', 'x-github-api-version': '2022-11-28' },
      redirect: 'manual',
    });
  } catch (error) {
    throw new SkillSourceError('unavailable', { cause: error });
  }
  // A repository that moved answers with a redirect: the address the person gave is no longer the skill's own.
  if (response.status >= 300 && response.status < 400) {
    throw new SkillSourceError('not_found');
  }
  if (response.status === 403 || response.status === 429) {
    throw new SkillSourceError('rate_limited');
  }
  return response;
}

/** The response body as text, refused once it passes the size limit so a huge file is never held in memory. */
async function readCapped(response: Response): Promise<string> {
  if (response.body === null) {
    return '';
  }
  const reader: ReadableStreamDefaultReader<Uint8Array> = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    size += value.byteLength;
    if (size > MAX_SKILL_FILE_BYTES) {
      await reader.cancel();
      throw new SkillSourceError('too_large');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function resolveCommit(input: { address: SkillAddress; fetchImpl: typeof fetch }): Promise<string> {
  const { owner, repo, ref } = input.address;
  if (ref !== undefined && FULL_COMMIT.test(ref)) {
    return ref;
  }
  const response = await githubGet({
    path: `/repos/${owner}/${repo}/commits/${encodePath(ref ?? 'HEAD')}`,
    accept: 'application/vnd.github+json',
    fetchImpl: input.fetchImpl,
  });
  if (response.status === 404 || response.status === 422) {
    throw new SkillSourceError('not_found');
  }
  if (!response.ok) {
    throw new SkillSourceError('unavailable');
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    throw new SkillSourceError('unavailable', { cause: error });
  }
  const sha = isRecord(body) ? body['sha'] : undefined;
  if (typeof sha !== 'string' || !FULL_COMMIT.test(sha)) {
    throw new SkillSourceError('unavailable');
  }
  return sha;
}

/** Splits a SKILL.md into the name and description of its opening block and the instructions after it. */
export function parseSkillFile(text: string): Omit<PublishedSkill, 'commit'> {
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const match = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)([\s\S]*)$/.exec(body);
  if (match === null) {
    throw new SkillSourceError('unreadable_skill_file');
  }
  let header: unknown;
  try {
    header = parse(match[1] ?? '');
  } catch (error) {
    throw new SkillSourceError('unreadable_skill_file', { cause: error });
  }
  if (!isRecord(header)) {
    throw new SkillSourceError('unreadable_skill_file');
  }
  const name = header['name'];
  const description = header['description'];
  if (typeof description !== 'string' || description.trim().length === 0) {
    throw new SkillSourceError('unreadable_skill_file');
  }
  return {
    name: typeof name === 'string' && name.trim().length > 0 ? name.trim() : undefined,
    description: description.trim(),
    instructions: (match[2] ?? '').trim(),
  };
}

/**
 * Reads one skill from a public GitHub repository. The branch or tag is settled to a full commit
 * first and the file is read at that commit, so what is shown is exactly what would be added.
 */
export async function readPublishedSkill(input: {
  address: SkillAddress;
  fetchImpl: typeof fetch;
}): Promise<PublishedSkill> {
  const { address, fetchImpl } = input;
  const commit = await resolveCommit({ address, fetchImpl });
  const file = address.path === undefined ? 'SKILL.md' : `${encodePath(address.path)}/SKILL.md`;
  const response = await githubGet({
    path: `/repos/${address.owner}/${address.repo}/contents/${file}?ref=${commit}`,
    accept: 'application/vnd.github.raw+json',
    fetchImpl,
  });
  if (response.status === 404) {
    throw new SkillSourceError('no_skill_file');
  }
  if (!response.ok) {
    throw new SkillSourceError('unavailable');
  }
  return { commit, ...parseSkillFile(await readCapped(response)) };
}
