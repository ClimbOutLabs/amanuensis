// Puts the fixture space into the eval instance through the normal spaces API, and removes it after the run.
import { readFile } from 'node:fs/promises';

/** The fixture space a run needs, in the create request's `space` shape. */
const SPACE_FIELDS = ['name', 'purpose', 'status', 'body', 'format'];

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Reads the fixture space file and checks it has every field the create request needs.
 * @param {string} file
 */
export async function loadSpaceFixture(file) {
  let value;
  try {
    value = JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    throw new Error(`Could not read the eval space fixture at ${file}. Check that the file exists and is valid JSON.`, {
      cause: error,
    });
  }
  const missing = isRecord(value) ? SPACE_FIELDS.filter(field => typeof value[field] !== 'string') : SPACE_FIELDS;
  if (missing.length > 0) {
    throw new Error(`The eval space fixture at ${file} is missing: ${missing.join(', ')}.`);
  }
  return Object.fromEntries(SPACE_FIELDS.map(field => [field, value[field]]));
}

/**
 * Creates the fixture space and returns what removing it needs.
 * @param {{ client: ReturnType<import('./client.mjs').createInstanceClient>, content: Record<string, string> }} options
 */
export async function seedSpace({ client, content }) {
  const list = await client.listSpaces();
  const created = await client.createSpace({
    space: content,
    expected_aggregate_revision: list.aggregate_revision,
  });
  return { id: created.space.id, revision: created.space.revision };
}

/**
 * Deletes the space a run seeded. A failure names the space, so it can be removed by hand.
 * @param {{ client: ReturnType<import('./client.mjs').createInstanceClient>, seeded: { id: string, revision: number } }} options
 */
export async function removeSpace({ client, seeded }) {
  try {
    await client.deleteSpace({ id: seeded.id, expected_revision: seeded.revision });
  } catch (error) {
    throw new Error(`Could not remove the eval space ${seeded.id}. Delete it by hand in the eval instance.`, {
      cause: error,
    });
  }
}
