import { EntitySchema } from "@mikro-orm/core";

export interface WalletLedgerEntryRow {
  id: string;
  walletId: string;
  transactionId: string;
  direction: "DEBIT" | "CREDIT";
  amount: string;
  balanceBefore: string;
  balanceAfter: string;
  createdAt: Date;
}

export const WalletLedgerEntryEntity =
  new EntitySchema<WalletLedgerEntryRow>({
    name: "WalletLedgerEntryEntity",
    tableName: "wallet_ledger_entries",

    properties: {
      id: {
        type: "uuid",
        primary: true,
      },

      walletId: {
        type: "uuid",
        fieldName: "wallet_id",
      },

      transactionId: {
        type: "uuid",
        fieldName: "transaction_id",
      },

      direction: {
        type: "string",
        length: 6,
      },

      amount: {
        type: "decimal",
        precision: 18,
        scale: 2,
      },

      balanceBefore: {
        type: "decimal",
        fieldName: "balance_before",
        precision: 18,
        scale: 2,
      },

      balanceAfter: {
        type: "decimal",
        fieldName: "balance_after",
        precision: 18,
        scale: 2,
      },

      createdAt: {
        type: "datetime",
        fieldName: "created_at",
      },
    },
  });