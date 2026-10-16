import { Migration } from "@mikro-orm/migrations";

export class Migration20261016180000 extends Migration {
    override name = "Migration20261016180000";

    override up(): void {
        this.addSql(`alter table wallet_ledger_entries add constraint ledger_wallet_transaction_unique unique (wallet_id, transaction_id)`);
        this.addSql(`
            create function reject_wallet_ledger_mutation() returns trigger
            language plpgsql as $$
            begin
                raise exception 'wallet_ledger_entries is immutable' using errcode = '55000';
            end;
            $$
        `);
        this.addSql(`create trigger wallet_ledger_immutable before update or delete or truncate
            on wallet_ledger_entries for each statement execute function reject_wallet_ledger_mutation()`);
        this.addSql(`alter table wager_transactions
            add column observed_balance numeric(18,2),
            add column observed_currency varchar(3),
            add constraint wager_observed_balance_valid check (
                (observed_balance is null and observed_currency is null) or
                (observed_balance is not null and observed_currency is not null
                 and observed_balance >= 0 and observed_currency ~ '^[A-Z]{3}$')
            )`);
        // Only the ledger can establish a historical balance; never use today's balance.
        this.addSql(`update wager_transactions t
            set observed_balance = l.balance_after, observed_currency = w.currency
            from wallet_ledger_entries l join wallets w on w.id = l.wallet_id
            where t.id = l.transaction_id and t.wallet_id = l.wallet_id
              and t.kind = 'BET' and t.status = 'PROCESSED'`);
    }

    override down(): void {
        this.addSql(`alter table wager_transactions drop constraint wager_observed_balance_valid,
            drop column observed_balance, drop column observed_currency`);
        this.addSql(`drop trigger wallet_ledger_immutable on wallet_ledger_entries`);
        this.addSql(`drop function reject_wallet_ledger_mutation()`);
        this.addSql(`alter table wallet_ledger_entries drop constraint ledger_wallet_transaction_unique`);
    }
}
