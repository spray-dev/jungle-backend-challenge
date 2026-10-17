import { EntityManager } from '@mikro-orm/postgresql';
import { Money } from '../../domain/money.js';
import { Wallet } from '../../domain/wallet.js';
import { WagerTransaction, WagerTransactionKind } from '../../domain/wager-transaction.js';
import { WalletLedgerEntry } from '../../domain/wallet-ledger-entry.js';
import { MikroOrmWalletRepository } from '../../persistence/repositories/mikro-orm-wallet.repository.js';
import { MikroOrmWagerTransactionRepository } from '../../persistence/repositories/mikro-orm-wager-transaction.repository.js';
import { MikroOrmWalletLedgerRepository } from '../../persistence/repositories/mikro-orm-wallet-ledger.repository.js';
import { enqueueWagerEvent } from './enqueue-wager-event.js';

export async function openWalletInTransaction(tx: EntityManager, playerId: string, initialBalance: Money): Promise<Wallet> {
    if (!tx.isInTransaction()) throw new Error('Opening requires an active transaction');
    if (initialBalance.isZero() || initialBalance.isNegative()) throw new Error('Initial balance must be positive');
    const wallet = Wallet.open({ id: crypto.randomUUID(), playerId, initialBalance });
    await new MikroOrmWalletRepository(tx).create(wallet);
    const id = crypto.randomUUID();
    const opening = WagerTransaction.create({ id, providerId: '__internal_opening__',
        externalTransactionId: id, idempotencyKey: id, payloadHash: id,
        walletId: wallet.id, playerId, roundId: id, gameId: '__opening__',
        kind: WagerTransactionKind.Opening, money: initialBalance, createdAt: wallet.createdAt });
    opening.markProcessed(undefined, wallet.createdAt, initialBalance);
    await new MikroOrmWagerTransactionRepository(tx).insert(opening);
    await new MikroOrmWalletLedgerRepository(tx).insert(WalletLedgerEntry.create({
        id: crypto.randomUUID(), walletId: wallet.id, transactionId: id, direction: 'CREDIT',
        amount: initialBalance, balanceBefore: Money.zero(wallet.currency), balanceAfter: initialBalance,
        createdAt: wallet.createdAt,
    }));
    await enqueueWagerEvent(tx, opening, wallet.createdAt);
    return wallet;
}
