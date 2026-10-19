import type { Tx } from '../persistence/db';
import type { Row } from '../persistence/schema';

/**
 * Outbox: messages Bookhand sends people (enrolment and reset links, lockout notices). A message is written in
 * the same transaction as the change that causes it, so it exists exactly when the change does, and is then
 * delivered by a transport:
 *  - a demo organization's messages go to its delivery log: they stay readable for their addressee, who opens
 *    them from the sign-in page, and every opening is audited (nobody uses a link silently);
 *  - a real organization's messages go to the transport the deployment plugs in (SMTP, an email API), the same
 *    way it plugs in an SSO verifier; once sent, the readable copy of the link is cleared. With none
 *    configured, messages wait in the outbox, queued.
 * The person who triggers a message never receives its link in a response.
 */

export type OutboxKind = Row<'outbox_messages'>['kind'];

export interface OutboxDraft {
  tenantId: string;
  toUserId: string | null;
  toEmail: string;
  kind: OutboxKind;
  subject: string;
  body: string;
  /** The addressee's single-use link, if any (a hash route such as #/enrol?token=...). */
  link?: string | null;
}

export interface OutboxTransport {
  readonly name: string;
  /** Send one message; throw when it could not be sent. */
  deliver(message: Pick<Row<'outbox_messages'>, 'to_email' | 'subject' | 'body' | 'link'>): Promise<void>;
}

export const DELIVERY_LOG = 'delivery-log';

/** Queue a message inside the caller's transaction. A demo organization's message lands in its delivery log at once. */
export async function queueMessage(tx: Tx, tenant: Pick<Row<'tenants'>, 'id' | 'is_demo'>, transport: OutboxTransport | null, draft: OutboxDraft, now: string): Promise<Row<'outbox_messages'>> {
  const row = await tx.insert('outbox_messages', {
    tenant_id: draft.tenantId,
    to_user_id: draft.toUserId,
    to_email: draft.toEmail,
    kind: draft.kind,
    subject: draft.subject,
    body: draft.body,
    link: draft.link ?? null,
    transport: tenant.is_demo ? DELIVERY_LOG : (transport?.name ?? 'none'),
    status: 'queued',
    created_at: now,
  });
  return tenant.is_demo ? tx.update('outbox_messages', row.id, { status: 'delivered', delivered_at: now }) : row;
}

/**
 * Hand queued messages of real organizations to the transport (after the transaction that queued them has
 * committed); a sent message keeps no readable link.
 */
export async function dispatchQueued(run: <T>(fn: (tx: Tx) => Promise<T>) => Promise<T>, transport: OutboxTransport | null, now: () => string): Promise<number> {
  if (!transport) return 0;
  const queued = await run((tx) => tx.find('outbox_messages', { status: 'queued', transport: transport.name }, { orderBy: [['created_at', 'asc']], limit: 50 }));
  let sent = 0;
  for (const m of queued) {
    try {
      await transport.deliver(m);
      await run((tx) => tx.update('outbox_messages', m.id, { status: 'delivered', delivered_at: now(), link: null }));
      sent++;
    } catch {
      await run((tx) => tx.update('outbox_messages', m.id, { status: 'failed' }));
    }
  }
  return sent;
}
