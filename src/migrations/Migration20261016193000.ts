import { Migration } from "@mikro-orm/migrations";

export class Migration20261016193000 extends Migration {
    override name = "Migration20261016193000";

    override up(): void {
        /*
         * PostgreSQL exige que o conjunto de colunas referenciado por uma
         * foreign key seja UNIQUE.
         *
         * id sozinho já é PK, portanto isto é logicamente redundante,
         * mas permite a FK composta (id, wallet_id).
         */
        this.addSql(`
      alter table "wager_transactions"
      add constraint "wager_transactions_id_wallet_unique"
      unique ("id", "wallet_id");
    `);

        /*
         * A FK antiga garantia somente:
         *
         * ledger.transaction_id -> wager_transactions.id
         *
         * Ela não garantia que ambas pertenciam à mesma wallet.
         */
        this.addSql(`
      alter table "wallet_ledger_entries"
      drop constraint "ledger_transaction_fk";
    `);

        /*
         * Agora a identidade da transação E a wallet precisam combinar.
         */
        this.addSql(`
      alter table "wallet_ledger_entries"
      add constraint "ledger_transaction_wallet_fk"
      foreign key ("transaction_id", "wallet_id")
      references "wager_transactions" ("id", "wallet_id")
      on delete restrict;
    `);
    }

    override down(): void {
        this.addSql(`
      alter table "wallet_ledger_entries"
      drop constraint "ledger_transaction_wallet_fk";
    `);

        this.addSql(`
      alter table "wallet_ledger_entries"
      add constraint "ledger_transaction_fk"
      foreign key ("transaction_id")
      references "wager_transactions" ("id")
      on delete restrict;
    `);

        this.addSql(`
      alter table "wager_transactions"
      drop constraint "wager_transactions_id_wallet_unique";
    `);
    }
}