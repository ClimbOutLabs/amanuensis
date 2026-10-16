/** The Google connection port the Harness adds on top of the runtime's connector port. */
import type { TrueForgeApi } from '@truefoundry/trueforge-sdk';

export type GoogleConnectionStatus = TrueForgeApi.GoogleConnectionStatus;
export type GoogleClientCheck = TrueForgeApi.GoogleClientCheck;
export type GoogleConsentStart = TrueForgeApi.GoogleConsentStart;
export type GoogleTestResult = TrueForgeApi.TestGoogleConnectionResult;
export type GoogleDisconnectResult = TrueForgeApi.DisconnectGoogleResult;
export type GoogleFeature = TrueForgeApi.GoogleFeature;

/** The client as the user gave it; the type is known only when it came from a downloaded client file. */
export interface GoogleClientDraft {
  clientId: string;
  clientSecret: string;
  clientType: 'desktop' | 'web' | null;
}

/** Operations behind Settings, Connectors, Google. */
export interface GoogleSetupPort {
  getGoogleStatus(): Promise<GoogleConnectionStatus>;
  /** "Check my client": local checks plus a dry request to Google. Nothing is stored. */
  checkGoogleClient(req: { client: GoogleClientDraft; registeredRedirectUris: string[] }): Promise<GoogleClientCheck>;
  /** A null client reuses the saved one, to add a feature or reconnect. */
  beginGoogleConsent(req: { client: GoogleClientDraft | null; features: GoogleFeature[] }): Promise<GoogleConsentStart>;
  /** Finishes a consent from the whole address the browser was sent to; the server reads the code and state. */
  completeGoogleConsent(req: { address: string }): Promise<GoogleConnectionStatus>;
  testGoogleConnection(): Promise<GoogleTestResult>;
  disconnectGoogle(): Promise<GoogleDisconnectResult>;
}

/** Whether a catalog implements the Google port; another host's catalog may not. */
export function hasGoogleSetup(catalog: object): catalog is GoogleSetupPort {
  return typeof Reflect.get(catalog, 'getGoogleStatus') === 'function';
}
