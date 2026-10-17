import type { EntityManager } from '@mikro-orm/postgresql';
import type { WalletMovement } from '../../domain/wallet.js';
import { WalletBalanceChanged } from '../../domain/events/wallet-balance-changed.event.js';
import { OutboxMessage } from '../../domain/outbox-message.js';
import { MikroOrmOutboxMessageRepository } from '../../persistence/repositories/mikro-orm-outbox-message.repository.js';

export async function enqueueBalanceEvent(tx: EntityManager, transactionId: string, movement: WalletMovement, at: Date) {
    if (!tx.isInTransaction()) throw new Error('Balance event requires an active transaction');
    await new MikroOrmOutboxMessageRepository(tx).insert(OutboxMessage.fromEvent(
        new WalletBalanceChanged(crypto.randomUUID(), at, transactionId, movement), at));
}
