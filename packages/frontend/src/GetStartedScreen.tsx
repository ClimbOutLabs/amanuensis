import { BrandLogo } from '@truefoundry/trueforge-ui';
import { loginHrefReturningTo } from './authFetch';
import './authScreens.css';

/**
 * Pre-auth welcome gate. Rendered when the session probe (`/me`) is unauthenticated
 * (OIDC configured but no session cookie yet). "Sign in" starts OIDC login and comes back to the
 * address the person opened, so a link such as the live browser page still lands there.
 */
export function GetStartedScreen() {
  return (
    <main className="auth-screen">
      <div className="auth-screen-card">
        <BrandLogo className="auth-screen-logo" />
        <h1 className="auth-screen-title">Welcome to Amanuensis</h1>
        <button
          type="button"
          className="auth-screen-button"
          onClick={() => {
            window.location.assign(loginHrefReturningTo(window.location));
          }}
        >
          Sign in
        </button>
      </div>
    </main>
  );
}
