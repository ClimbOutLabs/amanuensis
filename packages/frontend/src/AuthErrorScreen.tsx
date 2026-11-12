import { BrandLogo } from '@truefoundry/trueforge-ui';
import { buildLoginHref } from './authFetch';
import './authScreens.css';
import { authErrorMessage, type AuthErrorReason } from './authStatusSearch';

/** OIDC / login failure status. Mirrors the welcome page layout. */
export function AuthErrorScreen({ reason }: { reason: AuthErrorReason }) {
  return (
    <main className="auth-screen">
      <div className="auth-screen-card">
        <BrandLogo className="auth-screen-logo" />
        <h1 className="auth-screen-title">Sign-in failed</h1>
        <p className="auth-screen-message">{authErrorMessage(reason)}</p>
        <a className="auth-screen-button" href={buildLoginHref()}>
          Try again
        </a>
      </div>
    </main>
  );
}
