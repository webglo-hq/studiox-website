/**
 * Enrolment and password-reset links. A credential never passes through an administrator: inviting
 * a person or resetting their password creates a single-use link that expires (72 hours for an
 * invitation, 24 for a reset), stores only its SHA-256, and sends it to the person through the
 * outbox. Opening the link lets that person choose their own password; it then stops working, as
 * does any older link.
 */
import { audit } from '../core/audit/audit';
import { DomainError, validation } from '../core/util/errors';
import { sha256Hex } from '../core/util/hash';
import { secureToken } from '../core/util/random';
import { addMinutes } from '../core/util/time';
import type { CredentialLinkRow, DbTx, UserRow } from '../schema';
import type { AppContext, RequestUser } from './context';
import { deliveredTo, send } from './outbox';

const LIFETIME_MINUTES: Record<CredentialLinkRow['purpose'], number> = { enrolment: 72 * 60, password_reset: 24 * 60 };

export interface LinkSent {
  /** where it went, e.g. "nora@… (demo mailbox on the sign-in page)" */
  to: string;
  expiresAt: string;
}

/** Create a link for `user` and send it to them; earlier links of theirs stop working. */
export async function sendLink(ctx: AppContext, tx: DbTx, u: RequestUser, user: Pick<UserRow, 'id' | 'email' | 'display_name'>, purpose: CredentialLinkRow['purpose'], context: string): Promise<LinkSent> {
  const now = ctx.clock.now().toISOString();
  for (const l of await tx.find('credential_links', { user_id: user.id, used_at: { isNull: true }, revoked_at: { isNull: true } })) await tx.update('credential_links', l.id, { revoked_at: now });
  const token = `tkl_${secureToken(32)}`;
  const expiresAt = addMinutes(now, LIFETIME_MINUTES[purpose]);
  await tx.insert('credential_links', { user_id: user.id, purpose, token_hash: sha256Hex(token), created_by: u.actor.id, created_at: now, expires_at: expiresAt, used_at: null, revoked_at: null });
  const link = `${ctx.config.publicOrigin ?? ''}/#/welcome?token=${token}`;
  const what = purpose === 'enrolment' ? 'Choose your password to start' : 'Choose a new password';
  const msg = await send(ctx, tx, {
    toUserId: user.id,
    to: user.email,
    kind: purpose,
    subject: purpose === 'enrolment' ? 'Your Tieout invitation' : 'Reset your Tieout password',
    text: `Hello ${user.display_name},\n\n${context}\n\n${what}: ${link}\n\nThe link works once and expires on ${expiresAt.slice(0, 16).replace('T', ' ')} UTC. If you did not expect this message, ignore it and tell your administrator.`,
  });
  return { to: deliveredTo(msg), expiresAt };
}

async function findLink(ctx: AppContext, token: string) {
  const hash = /^tkl_[0-9a-f]{64}$/.test(String(token ?? '')) ? sha256Hex(token) : null;
  const tenantId = hash ? await ctx.db.tenantOf('credential_link', hash) : null;
  return { hash, tenantId };
}

function unusable(link: CredentialLinkRow | undefined, user: UserRow | undefined, now: string): string | null {
  if (!link || !user) return 'This link is not valid.';
  if (link.used_at) return 'This link was already used. Sign in with your password, or ask your administrator for a new link.';
  if (link.revoked_at) return link.purpose === 'enrolment' && user.status === 'active' ? 'Your account is already set up. Sign in instead.' : 'A newer link replaced this one. Use the latest message you received.';
  if (link.expires_at <= now) return 'This link has expired. Ask your administrator to send a new one.';
  if (user.status === 'disabled') return 'This account is disabled.';
  return null;
}

/** What a link is for, so the page can greet the person (nothing sensitive). */
export async function peekLink(ctx: AppContext, token: string) {
  const { hash, tenantId } = await findLink(ctx, token);
  if (!hash || !tenantId) throw new DomainError('not_found', 'This link is not valid.');
  return ctx.db.tx(tenantId, async (tx) => {
    const link = await tx.findOne('credential_links', { token_hash: hash });
    const user = link ? await tx.get('users', link.user_id) : undefined;
    const problem = unusable(link, user, ctx.clock.now().toISOString());
    if (problem) throw new DomainError('not_found', problem);
    return { purpose: link!.purpose, name: user!.display_name, email: user!.email, expiresAt: link!.expires_at };
  });
}

/** The person chooses their password with the link; the link is used up and they sign in as usual. */
export async function redeemLink(ctx: AppContext, token: string, password: string, meta: { ip: string | null }) {
  const gate = ctx.limiter.check(`link:${meta.ip ?? '-'}`, 20, 60_000);
  if (!gate.ok) throw new DomainError('rate_limited', 'Too many attempts. Wait a minute and try again.', { retryAfterSec: gate.retryAfterSec });
  const { hash, tenantId } = await findLink(ctx, token);
  if (!hash || !tenantId) throw new DomainError('not_found', 'This link is not valid.');
  let passwordHash: string;
  try {
    passwordHash = await ctx.hasher.hash(String(password ?? ''));
  } catch (e) {
    throw validation((e as Error).message);
  }
  return ctx.db.tx(tenantId, async (tx) => {
    const link = await tx.findOne('credential_links', { token_hash: hash });
    const user = link ? await tx.get('users', link.user_id) : undefined;
    const now = ctx.clock.now().toISOString();
    const problem = unusable(link, user, now);
    if (problem) throw new DomainError('not_found', problem);
    await tx.update('credential_links', link!.id, { used_at: now });
    await tx.update('users', user!.id, { password_hash: passwordHash, must_change_password: false, status: user!.status === 'invited' ? 'active' : user!.status, failed_logins: 0, locked_until: null });
    for (const s of await tx.find('sessions', { user_id: user!.id, revoked_at: { isNull: true } })) await tx.update('sessions', s.id, { revoked_at: now, revoked_reason: 'password set with a link' });
    await audit(tx, { type: 'user', id: user!.id, label: user!.display_name }, ctx.clock, { action: link!.purpose === 'enrolment' ? 'auth.enrolment.complete' : 'auth.password.reset_complete', subjectType: 'user', subjectId: user!.id, summary: `${user!.display_name} chose a password with ${link!.purpose === 'enrolment' ? 'their invitation' : 'a password-reset'} link`, data: { linkId: link!.id } }, meta.ip);
    return { email: user!.email };
  });
}
