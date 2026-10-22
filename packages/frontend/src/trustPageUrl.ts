/**
 * The address of the page where a device learns to trust this computer, from
 * `window.__TRUEFORGE_TRUST_PAGE_URL__` (the server substitutes the address
 * the installer printed). Empty when the installer did not set one, in which
 * case the app names the page without an address.
 */
declare global {
  interface Window {
    __TRUEFORGE_TRUST_PAGE_URL__?: string;
  }
}

const SHELL_TRUST_PAGE_TOKEN = '%%TRUEFORGE_TRUST_PAGE_URL%%';

function documentTrustPageUrl(): string {
  if (typeof window === 'undefined') {
    return '';
  }
  const value = window.__TRUEFORGE_TRUST_PAGE_URL__?.trim();
  if (value === undefined || value === '' || value.includes(SHELL_TRUST_PAGE_TOKEN)) {
    return '';
  }
  return value;
}

export const TRUST_PAGE_URL = documentTrustPageUrl();
