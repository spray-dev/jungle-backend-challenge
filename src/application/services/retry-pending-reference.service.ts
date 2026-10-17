import { Logger } from "@nestjs/common";
import type { EntityManager } from "@mikro-orm/postgresql";
import { ConcurrencyConflictError } from "../../domain/ports/concurrency-conflict.error.js";
import { MikroOrmReferenceRetryRepository, MAX_REFERENCE_ATTEMPTS } from "../../persistence/repositories/mikro-orm-reference-retry.repository.js";
import { processWagerInTransaction } from "./process-wager.service.js";

export function safeRetryErrorCode(error: unknown): string {
    if (error instanceof ConcurrencyConflictError) return "CONCURRENCY_CONFLICT";
    const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
    return typeof code === "string" && /^[A-Z0-9_]{1,40}$/.test(code) ? code : "UNKNOWN";
}

export class RetryPendingReferenceService {
    private readonly logger = new Logger(RetryPendingReferenceService.name);
    constructor(private readonly em: EntityManager) {}
    async retryPending(limit = 10, now = new Date()): Promise<number> {
        if (this.em.isInTransaction()) throw new Error("Reference retry service must own its transactions");
        if (!Number.isInteger(limit) || limit < 1) throw new Error("Retry limit must be a positive integer");
        const visited: string[] = [];
        while (visited.length < limit) {
            let transactionId: string | undefined;
            for (let attempt = 1; ; attempt++) {
                try {
                    const claimed = await this.em.fork().transactional(async tx => {
                        const repository = new MikroOrmReferenceRetryRepository(tx);
                        const row = await repository.claimDue(now, visited);
                        if (!row) return false;
                        transactionId = row.id;
                        await processWagerInTransaction(tx, row.id, undefined, undefined,
                            { attempts: Math.min(row.reference_attempts + 1, MAX_REFERENCE_ATTEMPTS), now });
                        return true;
                    }, { clear: true });
                    if (!claimed) return visited.length;
                    visited.push(transactionId!);
                    break;
                } catch (error) {
                    if (error instanceof ConcurrencyConflictError && attempt < 5) continue;
                    const errorCode = safeRetryErrorCode(error);
                    const permanent = errorCode === "22003";
                    this.logger.error({ event: "pending_reference_item_failed", transactionId,
                        errorCode, category: permanent ? "permanent_operation" : "technical", attempt });
                    // A failed claim has no item to isolate (e.g. database unavailable).
                    if (!transactionId) throw error;
                    visited.push(transactionId);
                    try {
                        await this.em.fork().transactional(tx =>
                            new MikroOrmReferenceRetryRepository(tx).deferTechnicalFailure(
                                transactionId!, now, permanent ? 60_000 : 5_000), { clear: true });
                    } catch (recoveryError) {
                        this.logger.error({ event: "pending_reference_reschedule_failed", transactionId,
                            errorCode: safeRetryErrorCode(recoveryError) });
                    }
                    // Even when rescheduling fails, never select this item again in this round.
                    break;
                }
            }
        }
        return visited.length;
    }
}
