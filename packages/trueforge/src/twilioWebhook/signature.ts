import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Twilio's request signature: the public URL, then each form field as name and value sorted by name, signed with the
 * account's auth token (HMAC-SHA1) and sent as base64 in `X-Twilio-Signature`.
 */
export function twilioSignature({
  authToken,
  url,
  params,
}: {
  authToken: string;
  url: string;
  params: URLSearchParams;
}): string {
  const fields = [...params.entries()].sort(([nameA, valueA], [nameB, valueB]) =>
    nameA === nameB ? (valueA < valueB ? -1 : valueA > valueB ? 1 : 0) : nameA < nameB ? -1 : 1,
  );
  const signed = fields.reduce((text, [name, value]) => `${text}${name}${value}`, url);
  return createHmac('sha1', authToken).update(signed, 'utf8').digest('base64');
}

/** True only when the header is the signature of this exact URL and these fields. The compare takes the same time whatever differs. */
export function verifyTwilioSignature({
  authToken,
  url,
  params,
  signature,
}: {
  authToken: string;
  url: string;
  params: URLSearchParams;
  signature: string | null | undefined;
}): boolean {
  if (signature === undefined || signature === null || signature === '') {
    return false;
  }
  const wanted = Buffer.from(twilioSignature({ authToken, url, params }));
  const given = Buffer.from(signature);
  return given.length === wanted.length && timingSafeEqual(given, wanted);
}
