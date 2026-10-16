import { Migration } from '@mikro-orm/migrations';

export class Migration20261015162923 extends Migration {

  override name = 'Migration20261015162923';

  override up(): void | Promise<void> {
    this.addSql(`create table "wallets" ("id" uuid not null, "player_id" varchar(255) not null, "currency" varchar(3) not null, "balance" numeric(18,2) not null, "version" int not null, "created_at" timestamptz not null, "updated_at" timestamptz not null, primary key ("id"));`);
    this.addSql(`alter table "wallets" add constraint "wallets_player_id_currency_unique" unique ("player_id", "currency");`);

    this.addSql(`create table "wallet_ledger_entries" ("id" uuid not null, "wallet_id" uuid not null, "transaction_id" uuid not null, "direction" varchar(6) not null, "amount" numeric(18,2) not null, "balance_before" numeric(18,2) not null, "balance_after" numeric(18,2) not null, "created_at" timestamptz not null, primary key ("id"));`);
    // Wallet: saldo e versão válidos
    this.addSql(`
      alter table "wallets"
      add constraint "wallets_balance_nonnegative"
      check ("balance" >= 0);
    `);

    this.addSql(`
      alter table "wallets"
      add constraint "wallets_version_positive"
      check ("version" >= 1);
    `);

    // Ledger: valores financeiros válidos
    this.addSql(`
      alter table "wallet_ledger_entries"
      add constraint "ledger_amount_positive"
      check ("amount" > 0);
    `);

    this.addSql(`
      alter table "wallet_ledger_entries"
      add constraint "ledger_balances_nonnegative"
      check ("balance_before" >= 0 and "balance_after" >= 0);
    `);

    this.addSql(`
      alter table "wallet_ledger_entries"
      add constraint "ledger_direction_valid"
      check ("direction" in ('DEBIT', 'CREDIT'));
    `);

    // Ledger: consistência matemática
    this.addSql(`
      alter table "wallet_ledger_entries"
      add constraint "ledger_balance_consistent"
      check (
        ("direction" = 'DEBIT' and "balance_after" = "balance_before" - "amount")
        or
        ("direction" = 'CREDIT' and "balance_after" = "balance_before" + "amount")
      );
    `);

    // Ledger: carteira deve existir
    this.addSql(`
      alter table "wallet_ledger_entries"
      add constraint "ledger_wallet_fk"
      foreign key ("wallet_id")
      references "wallets" ("id")
      on delete restrict;
    `);
  }

  override down(): void | Promise<void> {
    this.addSql(`drop table if exists "wallet_ledger_entries";`);
    this.addSql(`drop table if exists "wallets";`);
  }
}
