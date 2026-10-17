import { createHash } from "node:crypto";
import { EntityManager } from "@mikro-orm/postgresql";
import { Money, type MoneyProps } from "../../domain/money.js";
import { WagerTransaction, WagerTransactionKind } from "../../domain/wager-transaction.js";
import { MikroOrmWagerTransactionRepository } from "../../persistence/repositories/mikro-orm-wager-transaction.repository.js";

export type SupportedWagerKind = "BET" | "WIN" | "LOSS";

export interface AcceptWagerCommand {
    kind: SupportedWagerKind;
    providerId: string;
    externalTransactionId: string;
    idempotencyKey: string;
    walletId: string;
    playerId: string;
    roundId: string;
    gameId: string;
    money: MoneyProps;
}

export interface AcceptWagerResult {
    transaction: WagerTransaction;
    idempotentReplay: boolean;
}

export class IdempotencyConflictError extends Error {
    readonly code = "IDEMPOTENCY_CONFLICT";
    constructor() { super("Provider identity or payload conflicts with an existing wager"); }
}

export async function acceptWagerInTransaction(
    tx: EntityManager,
    command: AcceptWagerCommand,
): Promise<AcceptWagerResult> {
    if (!tx.isInTransaction()) {
        throw new Error(
            "acceptWagerInTransaction requires an active transaction",
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
                "Invalid wager identity",
            );
        }
    }

    if (!["BET", "WIN", "LOSS"].includes(command.kind)) {
        throw new Error("Only BET/WIN/LOSS are supported");
    }

    const money =
        Money.from(command.money);

    if (
        money.isNegative() &&
        !money.isZero()
    ) {
        throw new Error(
            "Wager amount must not be negative",
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
                        command.kind as WagerTransactionKind,

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
                command.kind as WagerTransactionKind,

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
// Fluxos externos podem usar acceptWagerInTransaction()
// dentro de uma transaction maior.
export class AcceptWagerService {
    constructor(
        private readonly em: EntityManager,
    ) { }

    async execute(
        command: AcceptWagerCommand,
    ): Promise<WagerTransaction> {
        if (this.em.isInTransaction()) {
            throw new Error(
                "AcceptWagerService must own its transaction",
            );
        }

        const result =
            await this.em
                .fork()
                .transactional(
                    tx =>
                        acceptWagerInTransaction(
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

