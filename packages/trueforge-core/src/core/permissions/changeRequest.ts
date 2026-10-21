const CHANGE_REQUEST_PREFIX = 'The person asked for changes before approving: ';
const CHANGE_REQUEST_SUFFIX = '. Make the changes and propose it again.';

/** The denial reason a "Change it" answer sends. The model reads it as that call's result. */
export function changeRequestReason(text: string): string {
  return `${CHANGE_REQUEST_PREFIX}${text.trim()}${CHANGE_REQUEST_SUFFIX}`;
}

/** True for a "Change it" denial. Such a denial never blocks a revised call from being proposed. */
export function isChangeRequestReason(reason: string | undefined): reason is string {
  return reason !== undefined && reason.startsWith(CHANGE_REQUEST_PREFIX) && reason.endsWith(CHANGE_REQUEST_SUFFIX);
}
