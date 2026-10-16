import { Migration } from "@mikro-orm/migrations";

export class Migration20261016144310 extends Migration {
  override name = "Migration20261016144310";

  override up(): void | Promise<void> {
    this.addSql(`
      create table "wager_transactions" (
        "id" uuid not null,
        "provider_id" varchar(255) not null,
        "external_transaction_id" varchar(255) not null,
        "idempotency_key" varchar(255) not null,
        "payload_hash" varchar(255) not null,
        "wallet_id" uuid not null,
        "player_id" varchar(255) not null,
        "round_id" varchar(255) not null,
        "game_id" varchar(255) not null,
        "kind" varchar(16) not null,
        "status" varchar(32) not null,
        "amount" numeric(18,2) not null,
        "currency" varchar(3) not null,
        "reference_external_transaction_id" varchar(255) null,
        "reference_transaction_id" uuid null,
        "failure_code" varchar(64) null,
        "created_at" timestamptz not null,
        "processed_at" timestamptz null,
        primary key ("id")
      );
    `);

    this.addSql(`
      alter table "wager_transactions"
      add constraint "wager_transactions_provider_external_unique"
      unique ("provider_id", "external_transaction_id");
    `);

    this.addSql(`
      alter table "wager_transactions"
      add constraint "wager_transactions_provider_idempotency_unique"
      unique ("provider_id", "idempotency_key");
    `);

    this.addSql(`
      alter table "wager_transactions"
      add constraint "wager_transactions_wallet_fk"
      foreign key ("wallet_id")
      references "wallets" ("id")
      on delete restrict;
    `);

    this.addSql(`
      alter table "wager_transactions"
      add constraint "wager_transactions_reference_fk"
      foreign key ("reference_transaction_id")
      references "wager_transactions" ("id")
      on delete restrict;
    `);

    this.addSql(`
      alter table "wager_transactions"
      add constraint "wager_transactions_amount_nonnegative"
      check ("amount" >= 0);
    `);

    this.addSql(`
      alter table "wager_transactions"
      add constraint "wager_transactions_kind_valid"
      check (
        "kind" in (
          'OPENING',
          'BET',
          'WIN',
          'LOSS',
          'REFUND',
          'ROLLBACK'
        )
      );
    `);

    this.addSql(`
      alter table "wager_transactions"
      add constraint "wager_transactions_status_valid"
      check (
        "status" in (
          'PENDING',
          'PENDING_REFERENCE',
          'PROCESSED',
          'REJECTED',
          'FAILED'
        )
      );
    `);

    this.addSql(`
      alter table "wager_transactions"
      add constraint "wager_transactions_currency_valid"
      check ("currency" ~ '^[A-Z]{3}$');
    `);

    this.addSql(`
      alter table "wager_transactions"
      add constraint "wager_transactions_reference_required"
      check (
        "kind" not in ('REFUND', 'ROLLBACK')
        or "reference_external_transaction_id" is not null
      );
    `);

    this.addSql(`
      alter table "wallet_ledger_entries"
      add constraint "ledger_transaction_fk"
      foreign key ("transaction_id")
      references "wager_transactions" ("id")
      on delete restrict;
    `);
  }

  override down(): void | Promise<void> {
    this.addSql(`
      alter table "wallet_ledger_entries"
      drop constraint if exists "ledger_transaction_fk";
    `);

    this.addSql(`
      drop table if exists "wager_transactions";
    `);
  }
}