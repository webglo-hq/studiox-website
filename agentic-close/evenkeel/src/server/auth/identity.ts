/**
 * Identity-provider seam. Password sign-in is built in; single sign-on providers (OIDC, SAML)
 * plug in here and map an external subject to an app_user (app_user.idp + external_subject).
 * The HTTP layer exposes /api/auth/sso/* routes only when a provider is registered.
 */
export interface ExternalIdentity {
  idp: 'oidc' | 'saml';
  subject: string;
  email: string;
  displayName?: string;
}

export interface IdentityProvider {
  readonly id: 'oidc' | 'saml';
  readonly label: string;
  /** URL to send the browser to; `state` and `verifier` are bound to the pre-auth session. */
  authorizationUrl(input: { state: string; codeChallenge: string; redirectUri: string }): Promise<string>;
  /** Validate the callback (signature, issuer, audience, nonce, expiry) and return the identity. */
  handleCallback(input: { params: URLSearchParams; state: string; codeVerifier: string; redirectUri: string }): Promise<ExternalIdentity>;
}

const registry = new Map<string, IdentityProvider>();

export function registerIdentityProvider(p: IdentityProvider): void {
  registry.set(p.id, p);
}

export function identityProviders(): IdentityProvider[] {
  return [...registry.values()];
}

export function identityProvider(id: string): IdentityProvider | undefined {
  return registry.get(id);
}
