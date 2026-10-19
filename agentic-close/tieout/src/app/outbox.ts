/**
 * The outbox: every message Tieout sends a person (an invitation, a password-reset link, a request
 * to approve access) is recorded here and handed to a delivery channel. Bodies are sealed with the
 * application key, so a link inside one is readable by its delivery only — never through an
 * administrator's screens or API.
 *
 * Channels: `email` queues the message for the email relay (the integration point for SMTP or a
 * mail API). `demo_mailbox` (demo and development) keeps it for the demo mailbox on the sign-in
 * page, where the person it is for reads it. The mailbox opens a message only for a browser that
 * is signed out — it belongs to the addressee, not to whoever sent it — and every opening is
 * written to the audit log, so nobody uses someone else's link unnoticed.
 */
import { audit } from '../core/audit/audit';
import { decryptSecret, encryptSecret } from '../core/auth/totp';
import { forbidden, notFound } from '../core/util/errors';
import type { DbTx, OutboxMessageRow } from '../schema';
import { DEMO_TENANT_ID } from '../packs/accounting/seed/scenario';
import type { AppContext } from './context';

export interface OutboxDelivery {
  channel: OutboxMessageRow['channel'];
  /** hand a message over: sent now, or waiting for the relay */
  deliver(message: { to: string; subject: string; text: string }): Promise<'delivered' | 'queued'>;
}

/** Demo and development: the message waits in the demo mailbox for the person it is addressed to. */
export const demoMailboxDelivery: OutboxDelivery = { channel: 'demo_mailbox', deliver: async () => 'delivered' };

/** Production: messages wait in the outbox for the email relay. */
export const emailRelayDelivery: OutboxDelivery = { channel: 'email', deliver: async () => 'queued' };

export interface Outgoing {
  toUserId: string | null;
  to: string;
  kind: OutboxMessageRow['kind'];
  subject: string;
  text: string;
}

/** Record a message and hand it to the delivery channel (inside the caller's unit of work). */
export async function send(ctx: AppContext, tx: DbTx, m: Outgoing): Promise<OutboxMessageRow> {
  const status = await ctx.outbox.deliver({ to: m.to, subject: m.subject, text: m.text });
  const now = ctx.clock.now().toISOString();
  return tx.insert('outbox_messages', { to_user_id: m.toUserId, to_address: m.to, kind: m.kind, subject: m.subject.slice(0, 300), body_sealed: await encryptSecret(m.text, ctx.config.encryptionKey), channel: ctx.outbox.channel, status, created_at: now, delivered_at: status === 'delivered' ? now : null, opened_at: null });
}

/** Where a message went, in words an administrator can repeat to the person ("check your inbox"). */
export function deliveredTo(row: OutboxMessageRow): string {
  return row.channel === 'demo_mailbox' ? `${row.to_address} (demo mailbox on the sign-in page)` : row.to_address;
}

function demoOnly(ctx: AppContext) {
  if (!ctx.config.demoMode) throw notFound('Demo mailbox');
}

/** The demo mailbox: who has mail, and from when (never the contents). */
export async function mailbox(ctx: AppContext) {
  demoOnly(ctx);
  return ctx.db.tx(DEMO_TENANT_ID, async (tx) => {
    const rows = await tx.find('outbox_messages', { channel: 'demo_mailbox' }, { orderBy: [['created_at', 'desc']], limit: 100 });
    return { messages: rows.map((r) => ({ id: r.id, to: r.to_address, subject: r.subject, kind: r.kind, sentAt: r.created_at, openedAt: r.opened_at })) };
  });
}

/**
 * Open one message in the demo mailbox. Refused to a signed-in browser: an administrator who sent
 * an invitation cannot read it from their own session. Every opening is audited.
 */
export async function openMail(ctx: AppContext, id: string, signedIn: boolean, ip: string | null) {
  demoOnly(ctx);
  if (signedIn) throw forbidden('Sign out first: the demo mailbox shows a message only to the person it is for, never to a signed-in user.');
  return ctx.db.tx(DEMO_TENANT_ID, async (tx) => {
    const m = await tx.get('outbox_messages', id);
    if (!m || m.channel !== 'demo_mailbox') throw notFound('Message', id);
    const now = ctx.clock.now().toISOString();
    if (!m.opened_at) await tx.update('outbox_messages', m.id, { opened_at: now });
    await audit(tx, { type: 'system', id: 'demo-mailbox', label: 'Demo mailbox' }, ctx.clock, { action: 'outbox.demo_mailbox.open', subjectType: 'outbox_message', subjectId: m.id, summary: `Demo mailbox: “${m.subject}” for ${m.to_address} opened`, data: { kind: m.kind, toUserId: m.to_user_id } }, ip);
    return { id: m.id, to: m.to_address, subject: m.subject, sentAt: m.created_at, text: await decryptSecret(m.body_sealed, ctx.config.encryptionKey) };
  });
}
