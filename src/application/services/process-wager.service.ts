import { enqueueWagerEvent } from "./enqueue-wager-event.js";
import { MikroOrmReferenceRetryRepository, MAX_REFERENCE_ATTEMPTS, referenceRetryDelay } from "../../persistence/repositories/mikro-orm-reference-retry.repository.js";
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
    allowedKinds: readonly WagerTransactionKind[] = [WagerTransactionKind.Bet, WagerTransactionKind.Win, WagerTransactionKind.Loss, WagerTransactionKind.Refund, WagerTransactionKind.Rollback],
    referenceRetry?: { attempts: number; now: Date },
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

    const referenceRepository = new MikroOrmReferenceRetryRepository(tx);
    await referenceRepository.lockReversal(transactionId);
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
        ![WagerTransactionKind.Bet, WagerTransactionKind.Win, WagerTransactionKind.Loss, WagerTransactionKind.Refund, WagerTransactionKind.Rollback].includes(wager.kind)
    ) {
        throw new Error(
            `Processor supports only ${allowedKinds.join("/")}`,
        );
    }

    if (wager.isTerminal()) {
        return wager;
    }

    if (wager.status === WagerTransactionStatus.PendingReference && !referenceRetry) return wager;
    const expectedStatus = wager.status;
    const at = referenceRetry?.now ?? new Date();
    const attempts = referenceRetry?.attempts ?? 0;
    let reference: WagerTransaction | undefined;
    let referenceFailure: FailureCode | undefined;
    if (wager.requiresReference()) {
        reference = await wagers.findByProviderAndExternalTransactionId(
            wager.providerId, wager.referenceExternalTransactionId!,
        ) ?? undefined;
        referenceFailure = reference ? wager.validateReferenceStructure(reference) : undefined;
        const waiting = reference && !referenceFailure &&
            [WagerTransactionStatus.Pending, WagerTransactionStatus.PendingReference].includes(reference.status);
        // Pending references are read without locks; their own processor must be free to advance.
        if (!reference || waiting) {
            if (attempts < MAX_REFERENCE_ATTEMPTS) {
                wager.markPendingReference();
                await wagers.update(wager, expectedStatus);
                await referenceRepository.schedule(wager.id, attempts, new Date(at.getTime() + referenceRetryDelay(attempts)));
                if (expectedStatus !== WagerTransactionStatus.PendingReference) await enqueueWagerEvent(tx, wager, at);
                return wager;
            }
            referenceFailure = reference ? FailureCode.ReferenceNotReady : FailureCode.ReferenceNotFound;
        } else {
            referenceFailure = wager.validateReference(reference);
            if (!referenceFailure) {
                await referenceRepository.lockProcessedReference(reference.id);
                if (await referenceRepository.hasProcessedReversal(reference.id, wager.kind)) {
                    referenceFailure = FailureCode.ReferenceAlreadyReversed;
                }
            }
        }
    }

    const persistDecision = async () => {
        await wagers.update(wager, expectedStatus);
        if (wager.requiresReference()) {
            await referenceRepository.schedule(wager.id, attempts, null);
            await enqueueWagerEvent(tx, wager, at);
        }
    };

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

    const failureCode = referenceFailure ?? (
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

                        : wager.requiresReference() && wager.ledgerDirectionFor(reference) === "DEBIT" && wallet.balance.isLessThan(wager.money)
                            ? FailureCode.ReversalWouldOverdraw : undefined);

    if (failureCode !== undefined) {
        wager.reject(
            failureCode,
            wallet.balance,
        );

        await persistDecision();

        return wager;
    }

    if (wager.kind === WagerTransactionKind.Loss) {
        // Claim the wager even without a wallet write: concurrent replays must win only once.
        wager.markProcessed(undefined, new Date(), wallet.balance);
        await wagers.update(wager, expectedStatus);
        return wager;
    }

    const movement = wager.ledgerDirectionFor(reference) === "DEBIT"
        ? wallet.debit(wager.money)
        : wallet.credit(wager.money);

    if (movement === null) {
        throw new Error(
            "Positive balance-affecting wager must produce a movement",
        );
    }

    wager.markProcessed(
        reference?.id,
        at,
        wallet.balance,
    );

    /*
     * Claim otimista da própria operação.
     * Protege múltiplas execuções concorrentes
     * da mesma operação.
     */
    await persistDecision();

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
        private readonly allowedKinds: readonly WagerTransactionKind[] = [WagerTransactionKind.Bet, WagerTransactionKind.Win, WagerTransactionKind.Loss, WagerTransactionKind.Refund, WagerTransactionKind.Rollback],
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
