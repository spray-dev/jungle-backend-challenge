import { createHash } from "node:crypto";
import { UniqueConstraintViolationException } from "@mikro-orm/core";
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

export class IdempotencyConflictError extends Error {
    readonly code = "IDEMPOTENCY_CONFLICT";
    constructor() { super("Provider identity or payload conflicts with an existing BET"); }
}

// Admission only: processing is still ProcessBetService.execute(persisted.id).
export class AcceptBetService {
    constructor(private readonly em: EntityManager) {}

    async execute(command: AcceptBetCommand): Promise<WagerTransaction> {
        if (this.em.isInTransaction()) throw new Error("AcceptBetService must own its transaction");
        for (const value of [command.providerId, command.externalTransactionId, command.idempotencyKey,
            command.walletId, command.playerId, command.roundId, command.gameId]) {
            if (typeof value !== "string" || !value.trim() || value.length > 255) throw new Error("Invalid BET identity");
        }
        const money = Money.from(command.money);
        if (money.isNegative() && !money.isZero()) throw new Error("BET amount must not be negative");
        // Explicit field order; envelope IDs, timestamps and caller-provided hashes are excluded.
        const payloadHash = createHash("sha256").update(JSON.stringify({
            providerId: command.providerId, externalTransactionId: command.externalTransactionId,
            walletId: command.walletId, playerId: command.playerId, roundId: command.roundId,
            gameId: command.gameId, kind: WagerTransactionKind.Bet, money: money.toJSON(),
        })).digest("hex");
        const candidate = WagerTransaction.create({
            ...command, id: crypto.randomUUID(), createdAt: new Date(),
            kind: WagerTransactionKind.Bet, money, payloadHash,
        });
        try {
            await new MikroOrmWagerTransactionRepository(this.em.fork()).insert(candidate);
            return candidate;
        } catch (error) {
            if (!(error instanceof UniqueConstraintViolationException)) throw error;
            // The failed INSERT has ended; read committed rows using a fresh identity map.
            const repository = new MikroOrmWagerTransactionRepository(this.em.fork());
            const byKey = await repository.findByProviderAndIdempotencyKey(command.providerId, command.idempotencyKey);
            const byExternal = await repository.findByProviderAndExternalTransactionId(command.providerId, command.externalTransactionId);
            if (!byKey && !byExternal) throw error;
            if (!byKey || !byExternal || byKey.id !== byExternal.id || !byKey.matchesPayload(payloadHash)) {
                throw new IdempotencyConflictError();
            }
            return byKey;
        }
    }
}
