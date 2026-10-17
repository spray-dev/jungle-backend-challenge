import { Migration } from "@mikro-orm/migrations";

// Manual migration: preserve every existing ledger trigger, check and foreign key.
export class Migration20261017020000 extends Migration {
    override name = "Migration20261017020000";
    override up(): void {
        this.addSql(`alter table wager_transactions
            add column reference_attempts integer not null default 0,
            add column reference_next_attempt_at timestamptz,
            add constraint wager_reference_attempts_valid check (reference_attempts between 0 and 5),
            add constraint wager_processed_reversal_reference check (
                kind not in ('REFUND', 'ROLLBACK') or status <> 'PROCESSED' or reference_transaction_id is not null
            )`);
        this.addSql(`create unique index wager_processed_reversal_unique
            on wager_transactions (reference_transaction_id, kind)
            where status = 'PROCESSED' and kind in ('REFUND', 'ROLLBACK')`);
        this.addSql(`update wager_transactions set reference_next_attempt_at = now()
            where status = 'PENDING_REFERENCE'`);
        this.addSql(`create index wager_reference_due_idx
            on wager_transactions (reference_next_attempt_at, id) where status = 'PENDING_REFERENCE'`);
    }
    override down(): void {
        this.addSql('drop index wager_reference_due_idx');
        this.addSql('drop index wager_processed_reversal_unique');
        this.addSql(`alter table wager_transactions drop constraint wager_processed_reversal_reference,
            drop constraint wager_reference_attempts_valid,
            drop column reference_next_attempt_at, drop column reference_attempts`);
    }
}
