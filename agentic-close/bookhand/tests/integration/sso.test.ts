import { beforeAll, describe, expect, it } from 'vitest';
import { App } from '../../src/app/app';
import { signInWithIdentity } from '../../src/app/usecases/sso';
import { seedScenario, type SeedResult } from '../../src/packs/accounting/seed/loader';
import { MemoryDb } from '../../src/persistence/memory';
import { configurePasswordHashing, DEMO_SCRYPT } from '../../src/security/passwords';

configurePasswordHashing({ params: DEMO_SCRYPT });

describe('SSO seam: linking verified identities to accounts', () => {
  let app: App;
  let db: MemoryDb;
  let seed: SeedResult;
  beforeAll(async () => {
    db = new MemoryDb();
    app = new App(db, { mode: 'server', secretKey: 'test'.repeat(8), sessionIdleMinutes: 30, sessionAbsoluteHours: 12, secureCookies: true });
    seed = await seedScenario(db);
  }, 60_000);

  it('refuses identities with no account, and never links a password account by email', async () => {
    await expect(signInWithIdentity(app, seed.tenantId, { provider: 'oidc', issuer: 'https://idp.example', subject: 'nobody', email: 'nobody@brambleway.example' })).rejects.toThrow(/has not set up a Bookhand account/);
    // Maya has a password account: an IdP asserting her email must not take it over.
    const maya = seed.logins.find((l) => l.key === 'maya')!;
    await expect(signInWithIdentity(app, seed.tenantId, { provider: 'oidc', issuer: 'https://idp.example', subject: 'attacker', email: maya.email })).rejects.toThrow(/has not set up/);
    const refused = await db.read((tx) => tx.find('audit_log', { tenant_id: seed.tenantId, action: 'auth.sso_refused' }));
    expect(refused).toHaveLength(2);
  });

  it('links an invited SSO user once by email, then only by subject, and records provider MFA', async () => {
    const invited = await db.tx((tx) => tx.insert('users', { tenant_id: seed.tenantId, email: 'ines.okoro@brambleway.example', display_name: 'Ines Okoro', password_hash: null, identity_provider: 'oidc', avatar_hue: 10 }));
    const first = await signInWithIdentity(app, seed.tenantId, { provider: 'oidc', issuer: 'https://idp.example', subject: 'abc-123', email: 'Ines.Okoro@brambleway.example', mfa: true });
    expect(first.user.id).toBe(invited.id);
    const session = await db.read((tx) => tx.findOne('sessions', { user_id: invited.id }));
    expect(session?.auth_method).toBe('oidc');
    expect(session?.mfa_verified).toBe(true);
    // A different subject asserting the same email is refused once the account is linked.
    await expect(signInWithIdentity(app, seed.tenantId, { provider: 'oidc', issuer: 'https://idp.example', subject: 'other-999', email: 'ines.okoro@brambleway.example' })).rejects.toThrow(/has not set up/);
    // The linked subject keeps working; a disabled account does not.
    expect((await signInWithIdentity(app, seed.tenantId, { provider: 'oidc', issuer: 'https://idp.example', subject: 'abc-123', email: 'changed@brambleway.example' })).user.id).toBe(invited.id);
    await db.tx((tx) => tx.update('users', invited.id, { status: 'disabled' }));
    await expect(signInWithIdentity(app, seed.tenantId, { provider: 'oidc', issuer: 'https://idp.example', subject: 'abc-123', email: 'ines.okoro@brambleway.example' })).rejects.toThrow(/disabled/);
  });
});
