/** Picture types chat accepts as input; anything else is refused or stays a file. */
export type ChatImageInputType = 'png' | 'jpeg' | 'gif' | 'webp';

/** The MIME type each accepted picture type is declared as, compared after lowercasing. */
export const CHAT_IMAGE_INPUT_MIME_TYPES: ReadonlyMap<string, ChatImageInputType> = new Map([
  ['image/png', 'png'],
  ['image/jpeg', 'jpeg'],
  ['image/gif', 'gif'],
  ['image/webp', 'webp'],
]);

/** Linked images one email may offer the chat. */
export const CHAT_IMAGE_MAX_PER_EMAIL = 20;

/**
 * Hosts that serve open-tracking pixels in mail. An image from one only tells the sender the email was
 * read, so chat never offers it. A subdomain counts too.
 */
const TRACKING_IMAGE_HOSTS: readonly string[] = [
  'list-manage.com',
  'sendgrid.net',
  'mailgun.org',
  'mandrillapp.com',
  'mcsv.net',
  'hubspotemail.net',
  'hs-analytics.net',
  'mixmax.com',
  'mailtrack.io',
  'yesware.com',
  'bananatag.com',
  'getnotify.com',
  'returnpath.net',
  'exct.net',
  'rs6.net',
  'sparkpostmail.com',
  'cmail19.com',
  'cmail20.com',
  'createsend1.com',
];

/** Path endings that name a tracking pixel whatever the host. */
const TRACKING_IMAGE_PATH = /\/(?:open|pixel|track(?:ing)?|beacon|wf\/open)(?:\.gif|\.png)?$/i;

/** True for an image link that only tells the sender the email was opened, which chat never shows. */
export function isTrackingImageLink(link: string): boolean {
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    return false;
  }
  const host = url.hostname.toLowerCase();
  if (TRACKING_IMAGE_HOSTS.some(tracker => host === tracker || host.endsWith(`.${tracker}`))) {
    return true;
  }
  return TRACKING_IMAGE_PATH.test(url.pathname);
}
