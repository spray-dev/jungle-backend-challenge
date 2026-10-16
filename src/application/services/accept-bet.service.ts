import { createHash } from "node:crypto";
import { EntityManager } from "@mikro-orm/postgresql";
import { Money, type MoneyProps } from "../../domain/money.js";
import { WagerTransaction, WagerTransactionKind } from "../../domain/wager-transaction.js";
import { MikroOrmWagerTransactionRepository } from "../../persistence/repositories/mikro-orm-wager-transaction.repository.js";

export interface AcceptBetCommand {
    providerId: string;
    externalTransactionId: string;
    idempotencyKey: string;
    walletId: string;
    playerId: string;
    roundId: string;
    gameId: string;
    money: MoneyProps;
}

export interface AcceptBetResult {
    transaction: WagerTransaction;
    idempotentReplay: boolean;
}

export class IdempotencyConflictError extends Error {
    readonly code = "IDEMPOTENCY_CONFLICT";
    constructor() { super("Provider identity or payload conflicts with an existing BET"); }
}

export async function acceptBetInTransaction(
    tx: EntityManager,
    command: AcceptBetCommand,
): Promise<AcceptBetResult> {
    if (!tx.isInTransaction()) {
        throw new Error(
            "acceptBetInTransaction requires an active transaction",
        );
    }

    for (const value of [
        command.providerId,
        command.externalTransactionId,
        command.idempotencyKey,
        command.walletId,
        command.playerId,
        command.roundId,
        command.gameId,
    ]) {
        if (
            typeof value !== "string" ||
            !value.trim() ||
            value.length > 255
        ) {
            throw new Error(
                "Invalid BET identity",
            );
        }
    }

    const money =
        Money.from(command.money);

    if (
        money.isNegative() &&
        !money.isZero()
    ) {
        throw new Error(
            "BET amount must not be negative",
        );
    }

    const payloadHash =
        createHash("sha256")
            .update(
                JSON.stringify({
                    providerId:
                        command.providerId,

                    externalTransactionId:
                        command.externalTransactionId,

                    walletId:
                        command.walletId,

                    playerId:
                        command.playerId,

                    roundId:
                        command.roundId,

                    gameId:
                        command.gameId,

                    kind:
                        WagerTransactionKind.Bet,

                    money:
                        money.toJSON(),
                }),
            )
            .digest("hex");

    const candidate =
        WagerTransaction.create({
            ...command,

            id: crypto.randomUUID(),

            createdAt:
                new Date(),

            kind:
                WagerTransactionKind.Bet,

            money,

            payloadHash,
        });

    const repository =
        new MikroOrmWagerTransactionRepository(
            tx,
        );

    const inserted =
        await repository.tryInsert(
            candidate,
        );

    if (inserted) {
        return {
            transaction: candidate,
            idempotentReplay: false,
        };
    }

    const byKey =
        await repository
            .findByProviderAndIdempotencyKey(
                command.providerId,
                command.idempotencyKey,
            );

    const byExternal =
        await repository
            .findByProviderAndExternalTransactionId(
                command.providerId,
                command.externalTransactionId,
            );

    if (
        !byKey ||
        !byExternal ||
        byKey.id !== byExternal.id ||
        !byKey.matchesPayload(payloadHash)
    ) {
        throw new IdempotencyConflictError();
    }

    return {
        transaction: byKey,
        idempotentReplay: true,
    };
}

// Wrapper transacional para admission via HTTP/outros callers.
// Fluxos externos podem usar acceptBetInTransaction()
// dentro de uma transaction maior.
export class AcceptBetService {
    constructor(
        private readonly em: EntityManager,
    ) { }

    async execute(
        command: AcceptBetCommand,
    ): Promise<WagerTransaction> {
        if (this.em.isInTransaction()) {
            throw new Error(
                "AcceptBetService must own its transaction",
            );
        }

        const result =
            await this.em
                .fork()
                .transactional(
                    tx =>
                        acceptBetInTransaction(
                            tx,
                            command,
                        ),
                    {
                        clear: true,
                    },
                );

        return result.transaction;
    }
}

