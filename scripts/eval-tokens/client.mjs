import { URL } from 'node:url';

// Calls the chat API the web UI uses: create a session, create a turn, read a turn.
// The bearer token is sent only as a request header and never leaves this module.

export class InstanceHttpError extends Error {
  /**
   * @param {string} message
   * @param {{ status: number, cause?: unknown }} options
   */
  constructor(message, { status, cause }) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'InstanceHttpError';
    this.status = status;
  }
}

export class InstanceUnreachableError extends Error {
  constructor(origin, { cause }) {
    super(`Could not reach ${origin}. Check that the instance is running and that --instance is correct.`, { cause });
    this.name = 'InstanceUnreachableError';
  }
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readErrorMessage(body, status) {
  if (isRecord(body) && isRecord(body.error) && typeof body.error.message === 'string') {
    return body.error.message.slice(0, 300);
  }
  return `The instance answered with HTTP ${String(status)}.`;
}

function readSessionId(body) {
  if (isRecord(body) && isRecord(body.data) && typeof body.data.id === 'string') {
    return body.data.id;
  }
  throw new Error('The instance did not return a session id. Is --instance a TrueForge server?');
}

function readTurn(body) {
  if (
    isRecord(body) &&
    isRecord(body.data) &&
    typeof body.data.id === 'string' &&
    isRecord(body.data.state) &&
    typeof body.data.state.status === 'string'
  ) {
    return body.data;
  }
  throw new Error('The instance did not return a turn. Is --instance a TrueForge server?');
}

/**
 * @param {{ baseUrl: string, token: string | undefined, fetchImpl?: typeof fetch }} options
 */
export function createInstanceClient({ baseUrl, token, fetchImpl = fetch }) {
  const origin = new URL(baseUrl).origin;
  const root = baseUrl.replace(/\/+$/, '');

  async function request(method, path, body) {
    const headers = { Accept: 'application/json' };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }
    if (token !== undefined && token !== '') {
      headers.Authorization = `Bearer ${token}`;
    }
    let response;
    try {
      response = await fetchImpl(`${root}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (error) {
      throw new InstanceUnreachableError(origin, { cause: error });
    }
    const text = await response.text();
    let json;
    try {
      json = text === '' ? undefined : JSON.parse(text);
    } catch (error) {
      throw new InstanceHttpError(`The instance sent a reply that is not JSON (HTTP ${String(response.status)}).`, {
        status: response.status,
        cause: error,
      });
    }
    if (!response.ok) {
      throw new InstanceHttpError(readErrorMessage(json, response.status), { status: response.status });
    }
    return json;
  }

  return {
    origin,
    /** Reads `/healthz`, which says whether the instance runs in eval mode. */
    async getHealth() {
      return await request('GET', '/healthz');
    },
    /**
     * @param {{ model: string, temperature: number }} options
     * @returns {Promise<string>} session id
     */
    async createSession({ model, temperature }) {
      const body = await request('POST', '/api/v1/sessions', {
        agent: { spec: { model: { name: model, params: { temperature } } } },
      });
      return readSessionId(body);
    },
    /**
     * Starts a turn without streaming. Poll `getTurn` until the state leaves `running`.
     * @param {string} sessionId
     * @param {{ input: unknown[], previous_turn_id: string }} options
     */
    async createTurn(sessionId, { input, previous_turn_id }) {
      const body = await request('POST', `/api/v1/sessions/${encodeURIComponent(sessionId)}/turns`, {
        input,
        previous_turn_id,
        stream: false,
      });
      return readTurn(body);
    },
    async getTurn(sessionId, turnId) {
      const body = await request(
        'GET',
        `/api/v1/sessions/${encodeURIComponent(sessionId)}/turns/${encodeURIComponent(turnId)}`,
      );
      return readTurn(body);
    },
    /** @returns {Promise<{ aggregate_revision: number }>} */
    async listSpaces() {
      const body = await request('GET', '/api/v1/spaces');
      if (!isRecord(body) || !isRecord(body.data) || typeof body.data.aggregate_revision !== 'number') {
        throw new Error('The instance did not return its spaces. Is --instance a TrueForge server?');
      }
      return body.data;
    },
    /** Every space, read page by page. The aggregate revision guards each continuation page. */
    async listAllSpaces() {
      const spaces = [];
      let offset = 0;
      let guard;
      for (;;) {
        const query = offset === 0 ? '' : `?offset=${String(offset)}&expected_aggregate_revision=${String(guard)}`;
        const body = await request('GET', `/api/v1/spaces${query}`);
        if (!isRecord(body) || !isRecord(body.data) || !Array.isArray(body.data.spaces)) {
          throw new Error('The instance did not return its spaces. Is --instance a TrueForge server?');
        }
        guard = body.data.aggregate_revision;
        spaces.push(...body.data.spaces);
        const next = isRecord(body.pagination) ? body.pagination.next_offset : null;
        if (typeof next !== 'number') {
          return spaces;
        }
        offset = next;
      }
    },
    /**
     * Reads one space, or one older revision of it. A revision past the kept history answers 404.
     * @param {{ id: string, revision?: number }} options
     */
    async getSpace({ id, revision }) {
      const query = revision === undefined ? '' : `?revision=${encodeURIComponent(String(revision))}`;
      const body = await request('GET', `/api/v1/spaces/${encodeURIComponent(id)}${query}`);
      if (!isRecord(body) || !isRecord(body.data) || typeof body.data.body !== 'string') {
        throw new Error('The instance did not return the space. Is --instance a TrueForge server?');
      }
      return body.data;
    },
    /**
     * @param {{ space: Record<string, string>, expected_aggregate_revision: number }} options
     * @returns {Promise<{ space: { id: string, revision: number } }>}
     */
    async createSpace({ space, expected_aggregate_revision }) {
      const body = await request('POST', '/api/v1/spaces', { space, expected_aggregate_revision });
      if (!isRecord(body) || !isRecord(body.data) || !isRecord(body.data.space)) {
        throw new Error('The instance did not return the new space. Is --instance a TrueForge server?');
      }
      return body.data;
    },
    /** @param {{ id: string, expected_revision: number }} options */
    async deleteSpace({ id, expected_revision }) {
      await request(
        'DELETE',
        `/api/v1/spaces/${encodeURIComponent(id)}?expected_revision=${encodeURIComponent(String(expected_revision))}`,
      );
    },
  };
}
