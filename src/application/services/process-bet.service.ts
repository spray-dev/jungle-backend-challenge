import { EntityManager } from "@mikro-orm/postgresql";
import { ConcurrencyConflictError } from "../../domain/ports/concurrency-conflict.error.js";
import type { WagerTransactionRepository } from "../../domain/ports/wager-transaction.repository.js";
import type { WalletRepository } from "../../domain/ports/wallet.repository.js";
import type { WalletLedgerRepository } from "../../domain/ports/wallet-ledger.repository.js";
import { FailureCode, WagerTransaction, WagerTransactionKind, WagerTransactionStatus } from "../../domain/wager-transaction.js";
import { WalletLedgerEntry } from "../../domain/wallet-ledger-entry.js";
import { MikroOrmWagerTransactionRepository } from "../../persistence/repositories/mikro-orm-wager-transaction.repository.js";
import { MikroOrmWalletRepository } from "../../persistence/repositories/mikro-orm-wallet.repository.js";
import { MikroOrmWalletLedgerRepository } from "../../persistence/repositories/mikro-orm-wallet-ledger.repository.js";

export interface BetRepositories {
    wagers: WagerTransactionRepository;
    wallets: WalletRepository;
    ledger: WalletLedgerRepository;
}

export type BetRepositoryFactory = (tx: EntityManager) => BetRepositories;

// Todos os adapters recebem exatamente o EntityManager da transação.
export const createBetRepositories: BetRepositoryFactory = tx => ({
    wagers: new MikroOrmWagerTransactionRepository(tx),
    wallets: new MikroOrmWalletRepository(tx),
    ledger: new MikroOrmWalletLedgerRepository(tx),
});

export class ProcessBetService {
    constructor(
        private readonly em: EntityManager,
        private readonly repositories: BetRepositoryFactory = createBetRepositories,
        private readonly maxAttempts = 5,
    ) {
        if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
            throw new Error("maxAttempts must be a positive integer");
        }
    }

    async execute(transactionId: string): Promise<WagerTransaction> {
        // O retry precisa controlar o commit real, nunca uma transação externa.
        if (this.em.isInTransaction()) {
            throw new Error("ProcessBetService must own its transaction");
        }
        for (let attempt = 1; ; attempt++) {
            try {
                // Identity map novo em cada tentativa e chamada concorrente.
                return await this.em.fork().transactional(async tx => {
                    const { wagers, wallets, ledger } = this.repositories(tx);
                    const bet = await wagers.findById(transactionId);
                    if (bet === null) throw new Error("Wager transaction not found");
                    if (bet.kind !== WagerTransactionKind.Bet) throw new Error("ProcessBetService supports only BET");
                    if (bet.isTerminal()) return bet;
                    if (bet.status !== WagerTransactionStatus.Pending) throw new Error("BET must be PENDING");

                    const wallet = await wallets.findById(bet.walletId);
                    if (wallet === null) throw new Error("Wallet not found");
                    const expectedVersion = wallet.version;
                    const expectedStatus = bet.status;
                    const failureCode = wallet.playerId !== bet.playerId ? FailureCode.PlayerMismatch
                        : wallet.currency !== bet.money.currency ? FailureCode.CurrencyMismatch
                        : bet.money.isZero() || bet.money.isNegative() ? FailureCode.InvalidAmount
                        : wallet.balance.isLessThan(bet.money) ? FailureCode.InsufficientFunds
                        : undefined;

                    if (failureCode !== undefined) {
                        bet.reject(failureCode);
                        await wagers.update(bet, expectedStatus);
                        return bet;
                    }

                    const movement = wallet.debit(bet.money);
                    if (movement === null) throw new Error("Positive BET must produce a movement");
                    await wallets.update(wallet, expectedVersion);
                    const at = new Date();
                    await ledger.insert(WalletLedgerEntry.create({
                        id: crypto.randomUUID(), walletId: wallet.id, transactionId: bet.id,
                        direction: movement.direction, amount: movement.money,
                        balanceBefore: movement.balanceBefore, balanceAfter: movement.balanceAfter,
                        createdAt: at,
                    }));
                    bet.markProcessed(undefined, at);
                    await wagers.update(bet, expectedStatus);
                    return bet;
                }, { clear: true });
            } catch (error) {
                // transactional já fez rollback. Erros de infraestrutura não viram rejeição.
                if (!(error instanceof ConcurrencyConflictError) || attempt >= this.maxAttempts) throw error;
            }
        }
    }
}
