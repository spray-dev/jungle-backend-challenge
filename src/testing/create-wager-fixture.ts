import type { EntityManager } from "@mikro-orm/postgresql";
import { Money } from "../domain/money.js";
import { WagerTransaction, WagerTransactionKind } from "../domain/wager-transaction.js";
import { MikroOrmWagerTransactionRepository } from "../persistence/repositories/mikro-orm-wager-transaction.repository.js";

// Os testes de ledger também precisam satisfazer a FK de transaction_id.
export async function createWagerFixture(em: EntityManager, walletId: string, transactionId: string): Promise<void> {
    await new MikroOrmWagerTransactionRepository(em).insert(WagerTransaction.create({
        id: transactionId, providerId: "integration", externalTransactionId: transactionId,
        idempotencyKey: transactionId, payloadHash: transactionId, walletId,
        playerId: `player-${walletId}`, roundId: transactionId, gameId: "game",
        kind: WagerTransactionKind.Bet, money: Money.from({ amount: "20.00", currency: "BRL" }),
        createdAt: new Date(),
    }));
}
