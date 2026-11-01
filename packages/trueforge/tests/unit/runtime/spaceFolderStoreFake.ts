import type { SpaceToolStore } from '../../../src/runtime/spaceCapability';

/** The folder half of a space tool store, for tests whose spaces are never filed. */
export const noSpaceFolders: Pick<
  SpaceToolStore,
  'listSpaceFolders' | 'createSpaceFolder' | 'setSpaceFolder' | 'listSpaceFolderAssignments'
> = {
  listSpaceFolders: () => Promise.resolve([]),
  createSpaceFolder: () => Promise.reject(new Error('These tests never create a folder.')),
  setSpaceFolder: () => Promise.reject(new Error('These tests never file a space.')),
  listSpaceFolderAssignments: () => Promise.resolve([]),
};
