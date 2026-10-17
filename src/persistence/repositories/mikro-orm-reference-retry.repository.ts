import type { EntityManager } from "@mikro-orm/postgresql";

export const MAX_REFERENCE_ATTEMPTS = 5;
export function referenceRetryDelay(attempts: number): number {
    return Math.min(1_000 * 2 ** attempts, 60_000);
}

// All claims and schedules live in the same SQL transaction as financial processing.
export class MikroOrmReferenceRetryRepository {
    constructor(private readonly em: EntityManager) {
        if (!em.isInTransaction()) throw new Error("Reference repository requires an active transaction");
    }

    async lockReversal(id: string): Promise<void> {
        await this.em.execute(`select id from wager_transactions
            where id = ? and kind in ('REFUND', 'ROLLBACK') for update`, [id]);
    }

    async lockProcessedReference(id: string): Promise<void> {
        // NO KEY UPDATE is compatible with FK KEY SHARE locks. Only processed targets
        // are locked, so dependent-before-reference cannot create a lock cycle.
        await this.em.execute(`select id from wager_transactions
            where id = ? and status = 'PROCESSED' for no key update`, [id]);
    }

    async hasProcessedReversal(referenceId: string, kind: string): Promise<boolean> {
        const rows = await this.em.execute<{ id: string }[]>(`select id from wager_transactions
            where reference_transaction_id = ? and kind = ? and status = 'PROCESSED'`, [referenceId, kind]);
        return rows.length > 0;
    }

    async schedule(id: string, attempts: number, nextAttemptAt: Date | null): Promise<void> {
        await this.em.execute(`update wager_transactions
            set reference_attempts = ?, reference_next_attempt_at = ? where id = ?`, [attempts, nextAttemptAt, id]);
    }

    async deferTechnicalFailure(id: string, now: Date, delayMs: number): Promise<void> {
        // Separate recovery transaction: never change reference_attempts or financial state.
        // A concurrent success or reschedule wins; do not overwrite it after rollback.
        await this.em.execute(`update wager_transactions set reference_next_attempt_at = ?
            where id = ? and status = 'PENDING_REFERENCE' and reference_next_attempt_at <= ?`,
            [new Date(now.getTime() + delayMs), id, now]);
    }

    async claimDue(now: Date, excluded: readonly string[] = []): Promise<{ id: string; reference_attempts: number } | undefined> {
        const rows = await this.em.execute<{ id: string; reference_attempts: number }[]>(`select id, reference_attempts
            from wager_transactions where status = 'PENDING_REFERENCE' and reference_next_attempt_at <= ?
            ${excluded.length ? `and id not in (${excluded.map(() => '?').join(',')})` : ''}
            order by reference_next_attempt_at, id limit 1 for update skip locked`, [now, ...excluded]);
        return rows[0];
    }
}
