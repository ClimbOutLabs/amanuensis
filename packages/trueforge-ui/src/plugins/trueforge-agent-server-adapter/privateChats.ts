import type { TrueForge, TrueForgeApi } from '@truefoundry/trueforge-sdk';

/** Where a chat's words go, for the private chat banner. */
export interface PrivateChatServerExtensions {
  getChatPrivacy(request: { sessionId: string }): Promise<TrueForgeApi.ChatPrivacy>;
}

export function createPrivateChatExtensions(client: Pick<TrueForge, 'sessions'>): PrivateChatServerExtensions {
  return {
    async getChatPrivacy({ sessionId }) {
      const response = await client.sessions.getPrivacy(sessionId);
      return response.data;
    },
  };
}

export function hasChatPrivacy(server: object): server is PrivateChatServerExtensions {
  return typeof Reflect.get(server, 'getChatPrivacy') === 'function';
}
