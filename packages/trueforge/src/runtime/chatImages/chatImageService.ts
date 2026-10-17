import { randomBytes } from 'node:crypto';

import type { ISessionStore } from '@truefoundry/trueforge-core/agent-session';
import {
  checkOutboundStrings,
  collectOutboundStrings,
  createWebSearchTurnState,
  extractBase64,
  recordResultUrls,
  remoteImageAskReason,
  type OutboundGuardRule,
  type OutboundGuardVerdict,
  type SentinelServices,
} from '@truefoundry/trueforge-core/core';

import type { ChatImageOrigin, ChatImageWithData, IChatImageStore } from '../../db/chatImageStore';
import type { ITurnArtifactStore } from '../../db/turnArtifactStore';
import type {
  ChatImageOutcome,
  ChatImageSource,
  CreateTurnImagesRequest,
  TurnImageList,
  TurnImagesResult,
} from '../../schemas/chatImages';
import { emailImageUrls, normalizeImageLink, replyImageUrls } from './imageLinks';
import { CHAT_IMAGE_OUTPUT_MIME } from './imageSniff';
import { CHAT_IMAGE_USER_MAX_BYTES } from './limits';
import type { ImageReencoder } from './reencodeInSandbox';
import { fetchRemoteImage, type RemoteImageFetchDeps } from './remoteImageFetch';
import { readTurnImageFacts } from './turnImageFacts';

/** The source named in a request does not exist in this turn. */
export class ChatImageNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ChatImageNotFoundError';
  }
}

/**
 * Rules that name an actual secret. After the person approves an image link, only these still stop
 * the fetch: the length and encoded-run rules would refuse ordinary image addresses the person chose.
 */
const SECRET_RULES: ReadonlySet<OutboundGuardRule> = new Set([
  'server_secret',
  'private_key',
  'jwt',
  'key_prefix',
  'card_number',
]);

const IMAGE_NAME = /\.(png|jpe?g|gif|webp)$/i;
const AUDIT_TOOL_NAME = 'show_image';
const AUDIT_URL_MAX_CHARS = 500;
const EMAIL_FETCH_BATCH = 4;

interface Owner {
  tenant_id: string;
  created_by: string;
}

interface TurnRef {
  owner: Owner;
  session_id: string;
  turn_id: string;
}

export interface ChatImageServiceDeps {
  store: IChatImageStore;
  sessionStore: Pick<ISessionStore, 'listTurnEvents'>;
  turnArtifactStore: Pick<ITurnArtifactStore, 'listArtifacts' | 'getArtifact' | 'getBlob'>;
  reencode: ImageReencoder;
  sentinel: Pick<SentinelServices, 'audit' | 'isOffline' | 'searchWithoutAsking' | 'outboundSecrets'>;
  fetchDeps: RemoteImageFetchDeps;
}

const UNINSPECTABLE: OutboundGuardVerdict = { ok: false, rule: 'uninspectable' };

function guardVerdict(input: { url: string; secrets: readonly string[] }): OutboundGuardVerdict {
  const strings = collectOutboundStrings({ url: input.url });
  return strings === undefined ? UNINSPECTABLE : checkOutboundStrings({ strings, secrets: input.secrets });
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

export function createChatImageService(deps: ChatImageServiceDeps) {
  async function storeLocal(input: {
    ref: TurnRef;
    source_key: string;
    origin: ChatImageOrigin;
    bytes: Buffer;
  }): Promise<ChatImageOutcome> {
    const reencoded = await deps.reencode({ bytes: input.bytes });
    if (!reencoded.ok) {
      return { status: 'refused', reason: reencoded.reason };
    }
    const stored = await deps.store.putImage({
      tenant_id: input.ref.owner.tenant_id,
      created_by: input.ref.owner.created_by,
      session_id: input.ref.session_id,
      turn_id: input.ref.turn_id,
      image_id: randomBytes(16).toString('hex'),
      source_key: input.source_key,
      origin: input.origin,
      mime: CHAT_IMAGE_OUTPUT_MIME[reencoded.image.type],
      width: reencoded.image.width,
      height: reencoded.image.height,
      data: reencoded.image.bytes,
      user_max_bytes: CHAT_IMAGE_USER_MAX_BYTES,
    });
    return { status: 'shown', image_id: stored.image_id, width: stored.width, height: stored.height };
  }

  async function cached(input: { ref: TurnRef; source_key: string }): Promise<ChatImageOutcome | undefined> {
    const found = await deps.store.findBySource({
      tenant_id: input.ref.owner.tenant_id,
      session_id: input.ref.session_id,
      source_key: input.source_key,
    });
    return found === undefined
      ? undefined
      : { status: 'shown', image_id: found.image_id, width: found.width, height: found.height };
  }

  async function audit(input: {
    ref: TurnRef;
    description: string;
    outcome: 'ran' | 'approved' | 'auto_denied';
  }): Promise<void> {
    await deps.sentinel.audit?.record({
      tenant_id: input.ref.owner.tenant_id,
      created_by: input.ref.owner.created_by,
      conversation_id: input.ref.session_id,
      tier: input.outcome === 'ran' ? 1 : 3,
      tool_name: AUDIT_TOOL_NAME,
      description: input.description,
      outcome: input.outcome,
      auto_deny_reason: input.outcome === 'auto_denied' ? 'outbound_guard' : null,
    });
  }

  /** Fetches, re-encodes and stores one remote image; the audit row is written before anything leaves. */
  async function showRemote(input: {
    ref: TurnRef;
    url: string;
    source_key: string;
    origin: 'remote_silent' | 'remote_approved';
  }): Promise<ChatImageOutcome> {
    const hit = await cached(input);
    if (hit !== undefined) {
      return hit;
    }
    if (await deps.sentinel.isOffline(input.ref.owner)) {
      return { status: 'refused', reason: 'offline' };
    }
    const secrets = await deps.sentinel.outboundSecrets(input.ref.owner);
    // A silent image passes the whole guard on every hop; an approved one only the secret rules.
    const allowUrl = (url: URL): boolean => {
      const verdict = guardVerdict({ url: url.toString(), secrets });
      return verdict.ok || (input.origin === 'remote_approved' && !SECRET_RULES.has(verdict.rule));
    };
    const first = normalizeImageLink(input.url);
    if (first === undefined || !allowUrl(new URL(first))) {
      // The link may hold the very secret the guard caught, so the row names only the site.
      await audit({
        ref: input.ref,
        description: `Blocked an image from ${hostOf(input.url)}`,
        outcome: 'auto_denied',
      });
      return { status: 'refused', reason: 'blocked' };
    }
    await audit({
      ref: input.ref,
      description: `Downloaded an image: ${input.url.slice(0, AUDIT_URL_MAX_CHARS)}`,
      outcome: input.origin === 'remote_silent' ? 'ran' : 'approved',
    });
    const fetched = await fetchRemoteImage({ url: input.url, allowUrl, deps: deps.fetchDeps });
    if (!fetched.ok) {
      return { status: 'refused', reason: fetched.reason };
    }
    return storeLocal({ ref: input.ref, source_key: input.source_key, origin: input.origin, bytes: fetched.bytes });
  }

  async function showLocal(input: {
    ref: TurnRef;
    source: Extract<ChatImageSource, { kind: 'upload' | 'artifact' }>;
  }): Promise<ChatImageOutcome> {
    const { ref, source } = input;
    const source_key = source.kind === 'upload' ? `upload:${String(source.index)}` : `artifact:${source.path}`;
    const hit = await cached({ ref, source_key });
    if (hit !== undefined) {
      return hit;
    }
    let bytes: Buffer | undefined;
    if (source.kind === 'upload') {
      const facts = await readTurnImageFacts({ sessionStore: deps.sessionStore, ...ref });
      const dataUri = facts.uploads[source.index];
      if (dataUri === undefined) {
        throw new ChatImageNotFoundError('No such attachment in this turn.');
      }
      try {
        bytes = extractBase64(dataUri);
      } catch {
        return { status: 'refused', reason: 'unsupported_type' };
      }
    } else {
      const artifact = await deps.turnArtifactStore.getArtifact({
        tenant_id: ref.owner.tenant_id,
        session_id: ref.session_id,
        turn_id: ref.turn_id,
        path: source.path,
      });
      if (artifact?.status !== 'stored' || artifact.digest === null) {
        throw new ChatImageNotFoundError('No such stored file in this turn.');
      }
      bytes = await deps.turnArtifactStore.getBlob({ tenant_id: ref.owner.tenant_id, digest: artifact.digest });
      if (bytes === undefined) {
        throw new ChatImageNotFoundError('The stored file is gone.');
      }
    }
    return storeLocal({ ref, source_key, origin: 'local', bytes });
  }

  async function showEmail(input: {
    ref: TurnRef;
    tool_call_id: string;
    approved: boolean;
  }): Promise<TurnImagesResult> {
    const facts = await readTurnImageFacts({ sessionStore: deps.sessionStore, ...input.ref });
    const html = facts.emailBodies.get(input.tool_call_id);
    if (html === undefined) {
      throw new ChatImageNotFoundError('No such email in this turn.');
    }
    const urls = emailImageUrls(html);
    if (urls.length === 0) {
      return { status: 'done', images: [] };
    }
    // Email images always ask: loading one tells the sender the email was opened.
    if (!input.approved) {
      return { status: 'ask', count: urls.length, host: null };
    }
    const images: ChatImageOutcome[] = [];
    // A few at a time: each has its own time budget, and the sandbox takes two at once anyway.
    for (let start = 0; start < urls.length; start += EMAIL_FETCH_BATCH) {
      const batch = urls.slice(start, start + EMAIL_FETCH_BATCH);
      images.push(
        ...(await Promise.all(
          batch.map(url =>
            showRemote({
              ref: input.ref,
              url,
              source_key: `email:${input.tool_call_id}:${url}`,
              origin: 'remote_approved',
            }),
          ),
        )),
      );
    }
    return { status: 'done', images };
  }

  async function showReply(input: { ref: TurnRef; url: string; approved: boolean }): Promise<TurnImagesResult> {
    const { ref } = input;
    const url = normalizeImageLink(input.url);
    const facts = await readTurnImageFacts({ sessionStore: deps.sessionStore, ...ref });
    const inReply = facts.replyTexts.some(text => url !== undefined && replyImageUrls(text).has(url));
    if (url === undefined || !inReply) {
      throw new ChatImageNotFoundError('That image link is not in this turn.');
    }
    const source_key = `reply:${url}`;
    const hit = await cached({ ref, source_key });
    if (hit !== undefined) {
      return { status: 'done', images: [hit] };
    }
    if (input.approved) {
      return {
        status: 'done',
        images: [await showRemote({ ref, url, source_key, origin: 'remote_approved' })],
      };
    }
    if (await deps.sentinel.isOffline(ref.owner)) {
      return { status: 'done', images: [{ status: 'refused', reason: 'offline' }] };
    }
    const state = createWebSearchTurnState();
    recordResultUrls({ state, texts: facts.silentSearchResults });
    const askReason = remoteImageAskReason({
      url,
      searchWithoutAsking: await deps.sentinel.searchWithoutAsking(ref.owner),
      guardPassed: guardVerdict({ url, secrets: await deps.sentinel.outboundSecrets(ref.owner) }).ok,
      silentShown: await deps.store.countTurnImages({
        tenant_id: ref.owner.tenant_id,
        session_id: ref.session_id,
        turn_id: ref.turn_id,
        origin: 'remote_silent',
      }),
      state,
    });
    if (askReason !== null) {
      return { status: 'ask', count: 1, host: hostOf(url) };
    }
    return { status: 'done', images: [await showRemote({ ref, url, source_key, origin: 'remote_silent' })] };
  }

  return {
    async listTurnImages(ref: TurnRef): Promise<TurnImageList> {
      const [artifacts, facts] = await Promise.all([
        deps.turnArtifactStore.listArtifacts({
          tenant_id: ref.owner.tenant_id,
          session_id: ref.session_id,
          turn_id: ref.turn_id,
        }),
        readTurnImageFacts({ sessionStore: deps.sessionStore, ...ref }),
      ]);
      return {
        artifacts: artifacts
          .filter(row => row.status === 'stored' && IMAGE_NAME.test(row.name))
          .map(row => ({ path: row.path, name: row.name })),
        emails: [...facts.emailBodies]
          .map(([tool_call_id, html]) => ({ tool_call_id, count: emailImageUrls(html).length }))
          .filter(email => email.count > 0),
      };
    },

    async showTurnImages(input: TurnRef & { request: CreateTurnImagesRequest }): Promise<TurnImagesResult> {
      const { request, ...ref } = input;
      const source = request.source;
      switch (source.kind) {
        case 'upload':
        case 'artifact':
          return { status: 'done', images: [await showLocal({ ref, source })] };
        case 'email':
          return showEmail({ ref, tool_call_id: source.tool_call_id, approved: request.approved });
        case 'reply':
          return showReply({ ref, url: source.url, approved: request.approved });
      }
    },

    getImage(input: {
      tenant_id: string;
      session_id: string;
      image_id: string;
    }): Promise<ChatImageWithData | undefined> {
      return deps.store.getImage(input);
    },
  };
}

export type ChatImageService = ReturnType<typeof createChatImageService>;
