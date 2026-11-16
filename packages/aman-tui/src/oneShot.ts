import { createChatClient, type ChatClient } from './chatClient.js';
import { ChatView as ChatViewFold } from './chatEvents.js';
import { activeInstance, loadInstanceStore } from './instances.js';
import { keyStoreForKind } from './keyStore.js';
import { chatErrorLine } from './serverErrors.js';

/** What a one-shot run needs from the world, injectable so the whole run can be tested. */
export interface OneShotDeps {
  print: (line: string) => void;
  printError: (line: string) => void;
  createChatClient?: (options: { baseUrl: string; token: string }) => ChatClient;
}

/**
 * Asks one question on the active instance, prints the answer, and exits.
 * There is no interactive chrome and nothing is ever approved here: when the
 * turn ends holding an action, the run says the answer is waiting for an
 * approval and where to answer it, and leaves the approval untouched. The
 * exit code is honest: zero only when an answer printed.
 */
export async function runOneShot(options: { configDir: string; question: string; deps: OneShotDeps }): Promise<number> {
  const { print, printError } = options.deps;
  const store = loadInstanceStore(options.configDir);
  const instance = activeInstance(store);
  if (instance === undefined) {
    printError('No Aman is paired with this terminal yet. Pair one with: aman-tui login <address>');
    return 1;
  }
  let key: string | undefined;
  try {
    key = await keyStoreForKind(instance.keyStore, { configDir: options.configDir }).get(instance.address);
  } catch {
    // A key store that cannot be read leaves the key as good as gone, and the
    // line below names the remedy for both.
    key = undefined;
  }
  if (key === undefined) {
    printError(
      `The key for ${instance.address} is not on this computer any more. Pair again with: aman-tui login ${instance.address}`,
    );
    return 1;
  }
  const makeClient =
    options.deps.createChatClient ??
    ((clientOptions: { baseUrl: string; token: string }) => createChatClient(clientOptions));
  const client = makeClient({ baseUrl: instance.address, token: key });
  const fold = new ChatViewFold(instance.address);
  try {
    const chat = await client.createChat();
    for await (const event of client.streamMessage(chat.id, options.question)) {
      fold.apply(event);
    }
  } catch (error) {
    const line = chatErrorLine(error, 'The answer did not finish. Check your connection, then try again.');
    printError(line.keyRefused ? `${line.message} Pair again with: aman-tui login ${instance.address}` : line.message);
    return 1;
  }
  fold.settle();
  let answerText = '';
  for (const block of fold.blocks) {
    if (block.kind === 'assistant' && block.text.trim() !== '') {
      answerText = block.text;
    }
  }
  if (answerText !== '') {
    print(answerText);
  }
  if (fold.pendingApprovals().length > 0) {
    print(
      `That is waiting for an approval, so there is no finished answer yet. Answer it in aman-tui, or in the web app: ${instance.address}`,
    );
    return 1;
  }
  return answerText === '' ? 1 : 0;
}
