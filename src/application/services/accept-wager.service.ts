import { canonicalJson } from "../../shared/canonical-json.js";
import { createHash } from "node:crypto";
import { EntityManager } from "@mikro-orm/postgresql";
import { Money, type MoneyProps } from "../../domain/money.js";
import { WagerTransaction, WagerTransactionKind } from "../../domain/wager-transaction.js";
import { MikroOrmWagerTransactionRepository } from "../../persistence/repositories/mikro-orm-wager-transaction.repository.js";

export type SupportedWagerKind = "BET" | "WIN" | "LOSS" | "REFUND" | "ROLLBACK";

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
    referenceExternalTransactionId?: string;
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

    if (!["BET", "WIN", "LOSS", "REFUND", "ROLLBACK"].includes(command.kind)) {
        throw new Error("Only BET/WIN/LOSS/REFUND/ROLLBACK are supported");
    }

    const reference = command.referenceExternalTransactionId;
    if ((reference !== undefined && (typeof reference !== "string" || !reference.trim() || reference.length > 255)) ||
        (["REFUND", "ROLLBACK"].includes(command.kind) && reference === undefined)) {
        throw new Error("Invalid or missing referenceExternalTransactionId");
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

    // Explicit business allowlist; headers and transport metadata never enter the hash.
    const businessPayload = {
        providerId: command.providerId,
        externalTransactionId: command.externalTransactionId,
        walletId: command.walletId,
        playerId: command.playerId,
        roundId: command.roundId,
        gameId: command.gameId,
        kind: command.kind,
        money: money.toJSON(),
    };
    const payloadHash = createHash("sha256").update(canonicalJson({
        ...businessPayload,
        ...(command.referenceExternalTransactionId === undefined ? {} : {
            referenceExternalTransactionId: command.referenceExternalTransactionId,
        }),
    })).digest("hex");

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
        !(byKey.matchesPayload(payloadHash) || (
            // Read compatibility with the pre-canonical algorithm; never write old hashes.
            (byKey.referenceExternalTransactionId ?? undefined) === command.referenceExternalTransactionId &&
            byKey.matchesPayload(createHash("sha256").update(JSON.stringify(businessPayload)).digest("hex"))
        ))
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

