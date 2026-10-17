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

export interface WagerRepositories {
    wagers: WagerTransactionRepository;
    wallets: WalletRepository;
    ledger: WalletLedgerRepository;
}

export type WagerRepositoryFactory = (tx: EntityManager) => WagerRepositories;

// Todos os adapters recebem exatamente o EntityManager da transação.
export const createWagerRepositories: WagerRepositoryFactory = tx => ({
    wagers: new MikroOrmWagerTransactionRepository(tx),
    wallets: new MikroOrmWalletRepository(tx),
    ledger: new MikroOrmWalletLedgerRepository(tx),
});

export async function processWagerInTransaction(
    tx: EntityManager,
    transactionId: string,
    repositories: WagerRepositoryFactory = createWagerRepositories,
    allowedKinds: readonly WagerTransactionKind[] = [WagerTransactionKind.Bet, WagerTransactionKind.Win, WagerTransactionKind.Loss],
): Promise<WagerTransaction> {
    if (!tx.isInTransaction()) {
        throw new Error(
            "processWagerInTransaction requires an active transaction",
        );
    }

    const {
        wagers,
        wallets,
        ledger,
    } = repositories(tx);

    const wager = await wagers.findById(
        transactionId,
    );

    if (wager === null) {
        throw new Error(
            "Wager transaction not found",
        );
    }

    if (
        !allowedKinds.includes(wager.kind) ||
        ![WagerTransactionKind.Bet, WagerTransactionKind.Win, WagerTransactionKind.Loss].includes(wager.kind)
    ) {
        throw new Error(
            `Processor supports only ${allowedKinds.join("/")}`,
        );
    }

    if (wager.isTerminal()) {
        return wager;
    }

    if (
        wager.status !==
        WagerTransactionStatus.Pending
    ) {
        throw new Error(
            "Wager must be PENDING",
        );
    }

    const wallet =
        await wallets.findById(
            wager.walletId,
        );

    if (wallet === null) {
        throw new Error(
            "Wallet not found",
        );
    }

    const expectedVersion =
        wallet.version;

    const expectedStatus =
        wager.status;

    const failureCode =
        wallet.playerId !== wager.playerId
            ? FailureCode.PlayerMismatch

            : wallet.currency !==
                wager.money.currency
                ? FailureCode.CurrencyMismatch

                : wager.money.isZero() ||
                    wager.money.isNegative()
                    ? FailureCode.InvalidAmount

                    : wager.kind === WagerTransactionKind.Bet && wallet.balance.isLessThan(
                        wager.money,
                    )
                        ? FailureCode.InsufficientFunds

                        : undefined;

    if (failureCode !== undefined) {
        wager.reject(
            failureCode,
            wallet.balance,
        );

        await wagers.update(
            wager,
            expectedStatus,
        );

        return wager;
    }

    if (wager.kind === WagerTransactionKind.Loss) {
        // Claim the wager even without a wallet write: concurrent replays must win only once.
        wager.markProcessed(undefined, new Date(), wallet.balance);
        await wagers.update(wager, expectedStatus);
        return wager;
    }

    const movement = wager.kind === WagerTransactionKind.Bet
        ? wallet.debit(wager.money)
        : wallet.credit(wager.money);

    if (movement === null) {
        throw new Error(
            "Positive balance-affecting wager must produce a movement",
        );
    }

    const at = new Date();

    wager.markProcessed(
        undefined,
        at,
        wallet.balance,
    );

    /*
     * Claim otimista da própria operação.
     * Protege múltiplas execuções concorrentes
     * da mesma operação.
     */
    await wagers.update(
        wager,
        expectedStatus,
    );

    /*
     * Optimistic lock da wallet.
     * Protege operações diferentes disputando
     * a mesma wallet.
     */
    await wallets.update(
        wallet,
        expectedVersion,
    );

    await ledger.insert(
        WalletLedgerEntry.create({
            id: crypto.randomUUID(),

            walletId:
                wallet.id,

            transactionId:
                wager.id,

            direction:
                movement.direction,

            amount:
                movement.money,

            balanceBefore:
                movement.balanceBefore,

            balanceAfter:
                movement.balanceAfter,

            createdAt:
                at,
        }),
    );

    return wager;
}

export class ProcessWagerService {
    constructor(
        private readonly em:
            EntityManager,

        private readonly repositories:
            WagerRepositoryFactory =
            createWagerRepositories,

        private readonly maxAttempts = 5,
        private readonly allowedKinds: readonly WagerTransactionKind[] = [WagerTransactionKind.Bet, WagerTransactionKind.Win, WagerTransactionKind.Loss],
    ) {
        if (
            !Number.isInteger(maxAttempts) ||
            maxAttempts < 1
        ) {
            throw new Error(
                "maxAttempts must be a positive integer",
            );
        }
    }

    async execute(
        transactionId: string,
    ): Promise<WagerTransaction> {
        if (this.em.isInTransaction()) {
            throw new Error(
                "ProcessWagerService must own its transaction",
            );
        }

        for (
            let attempt = 1;
            ;
            attempt++
        ) {
            try {
                return await this.em
                    .fork()
                    .transactional(
                        tx =>
                            processWagerInTransaction(
                                tx,
                                transactionId,
                                this.repositories,
                                this.allowedKinds,
                            ),
                        {
                            clear: true,
                        },
                    );
            } catch (error) {
                if (
                    !(
                        error instanceof
                        ConcurrencyConflictError
                    ) ||
                    attempt >=
                    this.maxAttempts
                ) {
                    throw error;
                }
            }
        }
    }
}
