// A skill case added from a chat: what Settings lists after the add, a run whose reply holds what the website
// shows right now, and nothing left after the remove. Whatever a case added is removed afterwards.
import { isRunStopping } from '../eval-tokens/run.mjs';

const HN_TOP_STORIES = 'https://hacker-news.firebaseio.com/v0/topstories.json';
const HN_ITEM = id => `https://hacker-news.firebaseio.com/v0/item/${String(id)}.json`;
/** The front page holds 30 stories; a reply asked for the top few names some of them. */
const HN_STORIES_READ = 30;
/** Enough of a title to know it, while a reply may shorten the rest. */
const TITLE_WORDS_MATCHED = 6;

function result({ check, pass, detail }) {
  return { check, pass, detail: pass ? '' : detail };
}

function plain(text) {
  return text
    .toLowerCase()
    .replace(/[‘’“”"'`*_]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The names of the skills added before a case, so only what the case added is checked and removed. */
export async function snapshotSkills({ client }) {
  return new Set((await client.listSkills()).map(skill => skill.name));
}

/**
 * After the add: exactly one new skill, listed in Settings, with the websites it needs approved.
 * Returns the checks and the new skill's name, for the later steps.
 * @param {{ client: any, before: Set<string>, websites: string[] }} options
 */
export async function checkSkillAdded({ client, before, websites }) {
  const added = (await client.listSkills()).filter(skill => !before.has(skill.name));
  const results = [
    result({
      check: 'one new skill is listed in Settings',
      pass: added.length === 1,
      detail: `${String(added.length)} new skills are listed`,
    }),
  ];
  const skill = added[0];
  if (skill === undefined) {
    return { results, name: undefined };
  }
  const approval = await client.getSkillNetworkApproval(skill.name);
  const allowed = Array.isArray(approval.allowed_hosts) ? approval.allowed_hosts : [];
  const missing = websites.filter(host => !allowed.includes(host));
  results.push(
    result({
      check:
        websites.length === 0
          ? 'the skill may reach at least one website'
          : `the skill may reach ${websites.join(', ')}`,
      pass: websites.length === 0 ? allowed.length > 0 : missing.length === 0,
      detail: allowed.length === 0 ? 'no website is approved' : `it may reach only ${allowed.join(', ')}`,
    }),
  );
  return { results, name: skill.name };
}

/** @param {{ client: any, name: string | undefined }} options */
export async function checkSkillRemoved({ client, name }) {
  if (name === undefined) {
    return [result({ check: 'the skill is gone from Settings', pass: false, detail: 'no skill was added earlier' })];
  }
  const still = (await client.listSkills()).some(skill => skill.name === name);
  return [result({ check: 'the skill is gone from Settings', pass: !still, detail: `${name} is still listed` })];
}

async function readJson({ url, fetchImpl }) {
  const response = await fetchImpl(url, { headers: { accept: 'application/json' } });
  if (!response.ok) {
    throw new Error(`Hacker News answered HTTP ${String(response.status)}.`);
  }
  return await response.json();
}

/** The titles on the Hacker News front page right now, read by the runner itself. */
export async function hackerNewsTitles({ fetchImpl = fetch } = {}) {
  const ids = await readJson({ url: HN_TOP_STORIES, fetchImpl });
  const items = await Promise.all(
    (Array.isArray(ids) ? ids : [])
      .slice(0, HN_STORIES_READ)
      .map(id => readJson({ url: HN_ITEM(id), fetchImpl }).catch(() => undefined)),
  );
  return items.flatMap(item => (typeof item?.title === 'string' ? [item.title] : []));
}

/** True when the reply names the title, or at least its opening words. */
export function replyNamesTitle({ reply, title }) {
  const text = plain(reply);
  const words = plain(title).split(' ');
  return text.includes(words.join(' ')) || text.includes(words.slice(0, TITLE_WORDS_MATCHED).join(' '));
}

/**
 * The reply names real titles from the front page as it is now, so it came from the website, not from memory.
 * @param {{ reply: string, atLeast: number, fetchImpl?: typeof fetch }} options
 */
export async function checkNewsTitles({ reply, atLeast, fetchImpl = fetch }) {
  const titles = await hackerNewsTitles({ fetchImpl });
  const named = titles.filter(title => replyNamesTitle({ reply, title }));
  return [
    result({
      check: `the reply names at least ${String(atLeast)} titles on the Hacker News front page now`,
      pass: named.length >= atLeast,
      detail:
        titles.length === 0
          ? 'the runner could not read Hacker News to compare'
          : `it names ${String(named.length)}; the front page starts with "${titles[0]}"`,
    }),
  ];
}

/**
 * Removes the skills a case added. Returns the names that could not be removed.
 * @param {{ client: any, before: Set<string> }} options
 */
export async function cleanUpSkills({ client, before }) {
  const problems = [];
  for (const skill of await client.listSkills()) {
    if (before.has(skill.name)) {
      continue;
    }
    try {
      await client.deleteSkill(skill.name);
    } catch (error) {
      if (isRunStopping(error)) {
        throw error;
      }
      problems.push(`the ${skill.name} skill`);
    }
  }
  return problems;
}
