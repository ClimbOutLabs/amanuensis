/** In-memory IChatImageStore for unit tests; the size cap and cascade are covered by the store contract suite. */
import type {
  ChatImageOrigin,
  ChatImageRecord,
  ChatImageWithData,
  IChatImageStore,
  PutChatImageInput,
} from '../../src/db/chatImageStore';

export class FakeChatImageStore implements IChatImageStore {
  readonly images = new Map<string, ChatImageWithData>();

  putImage(input: PutChatImageInput): Promise<ChatImageRecord> {
    const existing = [...this.images.values()].find(
      image => image.session_id === input.session_id && image.source_key === input.source_key,
    );
    if (existing !== undefined) {
      return Promise.resolve(existing);
    }
    const image: ChatImageWithData = {
      tenant_id: input.tenant_id,
      created_by: input.created_by,
      session_id: input.session_id,
      turn_id: input.turn_id,
      image_id: input.image_id,
      source_key: input.source_key,
      origin: input.origin,
      mime: input.mime,
      width: input.width,
      height: input.height,
      data: input.data,
      size: input.data.byteLength,
      created_at: new Date().toISOString(),
    };
    this.images.set(`${input.session_id} ${input.image_id}`, image);
    return Promise.resolve(image);
  }

  getImage(input: { tenant_id: string; session_id: string; image_id: string }): Promise<ChatImageWithData | undefined> {
    const image = this.images.get(`${input.session_id} ${input.image_id}`);
    return Promise.resolve(image?.tenant_id === input.tenant_id ? image : undefined);
  }

  findBySource(input: {
    tenant_id: string;
    session_id: string;
    source_key: string;
  }): Promise<ChatImageRecord | undefined> {
    return Promise.resolve(
      [...this.images.values()].find(
        image =>
          image.tenant_id === input.tenant_id &&
          image.session_id === input.session_id &&
          image.source_key === input.source_key,
      ),
    );
  }

  countTurnImages(input: {
    tenant_id: string;
    session_id: string;
    turn_id: string;
    origin: ChatImageOrigin;
  }): Promise<number> {
    return Promise.resolve(
      [...this.images.values()].filter(
        image =>
          image.tenant_id === input.tenant_id &&
          image.session_id === input.session_id &&
          image.turn_id === input.turn_id &&
          image.origin === input.origin,
      ).length,
    );
  }

  deleteImagesOlderThan(input: { older_than: string }): Promise<number> {
    let deleted = 0;
    for (const [key, image] of this.images) {
      if (image.created_at < input.older_than) {
        this.images.delete(key);
        deleted += 1;
      }
    }
    return Promise.resolve(deleted);
  }
}
