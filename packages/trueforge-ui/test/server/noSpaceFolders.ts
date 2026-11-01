import type { SpaceStore } from '@/server/SpaceContext.js';

/** Folder half of a SpaceStore for tests that do not care about folders: none exist and none can be made. */
export const noSpaceFolders: Pick<
  SpaceStore,
  'listFolders' | 'createFolder' | 'renameFolder' | 'deleteFolder' | 'setSpaceFolder'
> = {
  listFolders: async () => [],
  createFolder: async () => {
    throw new Error('Folders are not part of this test');
  },
  renameFolder: async () => {
    throw new Error('Folders are not part of this test');
  },
  deleteFolder: async () => {},
  setSpaceFolder: async () => {},
};
