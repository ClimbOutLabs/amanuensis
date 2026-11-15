export { createChatClient, type ChatClient, type ChatSummary } from './chatClient.js';
export { ChatView, type ChatEvent, type ViewBlock } from './chatEvents.js';
export { resolveConfigDir } from './configDir.js';
export {
  activeInstance,
  loadInstanceStore,
  normalizeInstanceAddress,
  saveInstanceStore,
  upsertInstance,
  type InstanceStore,
  type KeyStoreKind,
  type SavedInstance,
} from './instances.js';
export {
  CommandFailedError,
  FileKeyStore,
  LinuxSecretStore,
  MacKeychainStore,
  chooseKeyStore,
  keyStoreForKind,
  runCommand,
  type CommandRunner,
  type KeyStore,
} from './keyStore.js';
export { defaultDeviceName, runLogin, type LoginDeps } from './login.js';
export {
  PairingRefusedError,
  createPairingClient,
  type PairingClient,
  type PairingCompletion,
  type PairingStart,
} from './pairing.js';
export {
  lastActiveWord,
  outcomeOfDisposition,
  outcomeWord,
  plainToolName,
  toolCallDetail,
  type ToolOutcome,
} from './words.js';
