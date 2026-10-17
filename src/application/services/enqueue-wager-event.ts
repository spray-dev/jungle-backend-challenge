import type { EntityManager } from "@mikro-orm/postgresql";
import { WagerTransaction, WagerTransactionStatus as Status } from "../../domain/wager-transaction.js";
import { WagerTransactionProcessedEvent } from "../../domain/events/wager-transaction-processed.event.js";
import { WagerTransactionRejectedEvent } from "../../domain/events/wager-transaction-rejected.event.js";
import { WagerTransactionPendingReferenceEvent } from "../../domain/events/wager-transaction-pending-reference.event.js";
import { OutboxMessage } from "../../domain/outbox-message.js";
import { MikroOrmOutboxMessageRepository } from "../../persistence/repositories/mikro-orm-outbox-message.repository.js";

export async function enqueueWagerEvent(tx: EntityManager, wager: WagerTransaction, at: Date): Promise<void> {
    const id = crypto.randomUUID();
    const event = wager.status === Status.Processed ? new WagerTransactionProcessedEvent(id, at, wager)
        : wager.status === Status.Rejected ? new WagerTransactionRejectedEvent(id, at, wager)
        : wager.status === Status.PendingReference ? new WagerTransactionPendingReferenceEvent(id, at, wager) : null;
    if (event) await new MikroOrmOutboxMessageRepository(tx).insert(OutboxMessage.fromEvent(event, at));
}
