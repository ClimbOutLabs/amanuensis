import type { TrueForgeApi } from '@truefoundry/trueforge-sdk';
import type { PersonalizationApi, PersonalizationProfile } from '@truefoundry/trueforge-ui';

const PROFILE_URL = '/api/v1/personalization/profile';
interface ProfileResponse {
  data: PersonalizationProfile | null;
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function parseProfile(data: unknown): PersonalizationProfile | null {
  if (data === null) {
    return null;
  }
  if (typeof data !== 'object') {
    throw new Error('The personalization response was invalid.');
  }

  const profile = data as Record<string, unknown>;
  // Absent on responses from a server predating the field; read as null.
  const learnedProfile = profile.learned_profile ?? null;
  // A server predating the toggle sends no switch at all. Its absence is carried through rather
  // than read as off: the two are indistinguishable once a value is invented, and the write
  // request is strict, so sending an invented switch back would make every save fail.
  const learningEnabled = profile.learning_enabled;
  if (
    !isNullableString(profile.assistant_name) ||
    !isNullableString(profile.assistant_identity) ||
    !isNullableString(profile.voice_guidance) ||
    !isNullableString(profile.user_profile) ||
    !isNullableString(learnedProfile) ||
    (learningEnabled !== undefined && typeof learningEnabled !== 'boolean') ||
    !Array.isArray(profile.pinned_preferences) ||
    !profile.pinned_preferences.every(item => typeof item === 'string')
  ) {
    throw new Error('The personalization response was invalid.');
  }

  return {
    assistant_name: profile.assistant_name,
    assistant_identity: profile.assistant_identity,
    voice_guidance: profile.voice_guidance,
    user_profile: profile.user_profile,
    pinned_preferences: profile.pinned_preferences,
    learned_profile: learnedProfile,
    ...(learningEnabled === undefined ? {} : { learning_enabled: learningEnabled }),
  };
}

async function readProfile(response: Response): Promise<PersonalizationProfile | null> {
  const body = (await response.json()) as ProfileResponse;
  return parseProfile(body.data);
}

// The server's actual shape (see RequestErrorResponseSchema, also `TrueForgeApi.RequestErrorResponse`
// on the generated SDK, reused here rather than re-declared) nests the human-readable text under
// `error.message`; a bare string `error`, or a top-level `message`, is also accepted for
// older/other callers. Passing the whole object to `Error()` would coerce it to the literal string
// "[object Object]", which is the bug this fallback chain exists to prevent.
//
// `response.json()` is untrusted runtime data no matter what type it is cast to, so every shape
// below is checked, not asserted: a `null` nested `error` (typeof null is 'object') falls through
// instead of throwing on `.message`, and an empty message at any level falls through to the next
// candidate instead of returning blank text.
function isRequestError(value: unknown): value is TrueForgeApi.RequestErrorResponseError {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { message?: unknown }).message === 'string' &&
    (value as { message: string }).message !== ''
  );
}

function extractErrorMessage(body: unknown, status: number): string {
  if (typeof body === 'object' && body !== null) {
    const { error, message } = body as { error?: unknown; message?: unknown };
    if (isRequestError(error)) {
      return error.message;
    }
    if (typeof error === 'string' && error !== '') {
      return error;
    }
    if (typeof message === 'string' && message !== '') {
      return message;
    }
  }
  return `Request failed (${String(status)}).`;
}

async function readError(response: Response): Promise<Error> {
  const body: unknown = await response.json().catch(() => null);
  const message = extractErrorMessage(body, response.status);
  console.error('Personalization request failed', { status: response.status, body });
  return new Error(message);
}

export function createPersonalizationApi(fetcher: typeof fetch): PersonalizationApi {
  return {
    async getProfile() {
      const response = await fetcher(PROFILE_URL);
      if (response.status === 404) {
        return null;
      }
      if (!response.ok) {
        throw await readError(response);
      }
      return await readProfile(response);
    },
    async updateProfile(profile) {
      const response = await fetcher(PROFILE_URL, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        // A switch the profile does not carry is a switch this server never sent, and it stays
        // off the wire: the request object is strict and would reject the unknown key.
        body: JSON.stringify({ profile }),
      });
      if (!response.ok) {
        throw await readError(response);
      }
      const saved = await readProfile(response);
      if (saved === null) {
        throw new Error('The personalization response did not include the saved profile.');
      }
      return saved;
    },
    async deleteProfile() {
      const response = await fetcher(PROFILE_URL, { method: 'DELETE' });
      if (!response.ok) {
        throw await readError(response);
      }
    },
  };
}
