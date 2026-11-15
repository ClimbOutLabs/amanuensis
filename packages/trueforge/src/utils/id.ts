import { ulid } from 'ulid';

/** Application-generated lowercase ULID for entity / resource ids. */
export function newId(): string {
  return ulid().toLowerCase();
}

/** What `newId` makes, for checking an id that arrived from outside. */
export const ID_SHAPE = /^[0-9a-z]{26}$/;
