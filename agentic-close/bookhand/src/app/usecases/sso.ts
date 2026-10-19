import { appendAudit } from '../../audit/audit';
import { createSession } from '../../security/sessions';
import { DomainError } from '../../shared/errors';
import type { App, RequestMeta } from '../app';
import { sessionPolicy } from './auth';

/**
 * Enterprise single sign-on seam (OIDC and SAML).
 *
 * A deployment plugs in an IdentityVerifier for its identity provider: for OIDC it validates the ID token
 * (signature against the provider's JWKS, issuer, audience, nonce, expiry); for SAML it validates the signed
 * assertion (certificate, audience, recipient, NotOnOrAfter). The verifier is deliberately not bundled: it
 * is deployment-specific and must use a maintained protocol library. Bookhand owns what happens next, which is
 * security-relevant and tested here:
 *  - an identity is linked to a user only by (tenant, provider, subject), or once, by email, to a user an
 *    administrator created for that provider; password accounts are never linked by email (an identity
 *    provider that lets people choose their email address must not be able to take over an account);
 *  - disabled users and unknown identities are refused (no silent just-in-time provisioning);
 *  - the session records the provider as its auth method, and the provider's MFA claim as mfa_verified.
 */

export type ExternalProvider = 'oidc' | 'saml';

export interface VerifiedIdentity {
  provider: ExternalProvider;
  /** Issuer (OIDC `iss` / SAML entity id) the verifier trusted. */
  issuer: string;
  /** Stable subject identifier at the provider (OIDC `sub` / SAML NameID). */
  subject: string;
  email: string;
  name?: string;
  /** The provider asserted multi-factor authentication (OIDC `amr` contains "mfa", SAML AuthnContext). */
  mfa?: boolean;
}

export interface IdentityVerifier {
  readonly provider: ExternalProvider;
  /** Validate a provider callback; throws on anything not cryptographically verified. */
  verify(callback: { query: Record<string, string>; body?: unknown }): Promise<VerifiedIdentity>;
}

export async function signInWithIdentity(app: App, tenantId: string, identity: VerifiedIdentity, meta: RequestMeta = {}) {
  const subject = `${identity.issuer}|${identity.subject}`;
  if (!identity.subject || !identity.issuer) throw new DomainError('UNAUTHENTICATED', 'The identity provider did not return a subject.');
  const email = identity.email.trim().toLowerCase();
  const outcome = await app.tx(async (tx) => {
    const now = app.clock.now();
    let user = await tx.findOne('users', { tenant_id: tenantId, identity_provider: identity.provider, external_subject: subject });
    if (!user) {
      const invited = await tx.findOne('users', { tenant_id: tenantId, email });
      if (!invited || invited.identity_provider !== identity.provider || invited.external_subject) return { refused: invited?.id ?? null } as const;
      user = await tx.update('users', invited.id, { external_subject: subject, updated_at: now });
      await appendAudit(tx, tenantId, { type: 'user', userId: user.id, label: user.display_name, ip: meta.ip }, { action: 'auth.sso_linked', objectType: 'user', objectId: user.id, summary: `Linked ${identity.provider.toUpperCase()} identity ${subject}` }, now);
    }
    if (user.status !== 'active') return { disabled: user.id } as const;
    await tx.update('users', user.id, { last_login_at: now, failed_login_count: 0, updated_at: now });
    const issued = await createSession(tx, { tenantId, userId: user.id, authMethod: identity.provider, state: 'active', mfaVerified: !!identity.mfa, ip: meta.ip, userAgent: meta.userAgent, now, policy: sessionPolicy(app) });
    await appendAudit(tx, tenantId, { type: 'user', userId: user.id, label: user.display_name, ip: meta.ip, requestId: meta.requestId }, { action: 'auth.login', objectType: 'session', objectId: issued.session.id, summary: `Signed in with ${identity.provider.toUpperCase()}${identity.mfa ? ' (provider MFA)' : ''}` }, now);
    return { token: issued.token, csrfToken: issued.session.csrf_token, user: { id: user.id, name: user.display_name, email: user.email } };
  });
  if ('refused' in outcome || 'disabled' in outcome) {
    // Recorded in its own transaction: a refusal must leave a trace even though nothing else changes.
    const objectId = 'refused' in outcome ? outcome.refused : outcome.disabled;
    await app.tx((tx) => appendAudit(tx, tenantId, { type: 'system', userId: null, label: `${identity.provider.toUpperCase()} sign-in`, ip: meta.ip }, { action: 'auth.sso_refused', objectType: 'user', objectId, summary: `Refused ${identity.provider.toUpperCase()} sign-in for ${email}: ${'refused' in outcome ? 'no account is set up for this identity' : 'the account is disabled'}` }, app.clock.now()));
    throw new DomainError('UNAUTHENTICATED', 'refused' in outcome ? 'Your organization has not set up a Bookhand account for this sign-in. Ask an administrator.' : 'This account is disabled.');
  }
  return outcome;
}
