import { describe, expect, test } from "bun:test";
import { Money } from "./money.js";
import { WalletLedgerEntry } from "./wallet-ledger-entry.js";

describe("WalletLedgerEntry", () => {
  test("creates a consistent debit entry", () => {
    const entry = WalletLedgerEntry.create({
      id: "entry-1",
      walletId: "wallet-1",
      transactionId: "transaction-1",
      direction: "DEBIT",
      amount: Money.from({
        amount: "25.00",
        currency: "BRL",
      }),
      balanceBefore: Money.from({
        amount: "100.00",
        currency: "BRL",
      }),
      balanceAfter: Money.from({
        amount: "75.00",
        currency: "BRL",
      }),
      createdAt: new Date(),
    });

    expect(entry.isBalanced()).toBe(true);
  });

  test("rejects an inconsistent debit entry", () => {
    expect(() =>
      WalletLedgerEntry.create({
        id: "entry-2",
        walletId: "wallet-1",
        transactionId: "transaction-2",
        direction: "DEBIT",
        amount: Money.from({
          amount: "25.00",
          currency: "BRL",
        }),
        balanceBefore: Money.from({
          amount: "100.00",
          currency: "BRL",
        }),
        balanceAfter: Money.from({
          amount: "90.00",
          currency: "BRL",
        }),
        createdAt: new Date(),
      }),
    ).toThrow("Inconsistent ledger entry");
  });

  test("protects createdAt from external mutation", () => {
    const originalDate = new Date("2026-01-01T12:00:00Z");

    const entry = WalletLedgerEntry.create({
      id: "entry-3",
      walletId: "wallet-1",
      transactionId: "transaction-3",
      direction: "DEBIT",
      amount: Money.from({
        amount: "25.00",
        currency: "BRL",
      }),
      balanceBefore: Money.from({
        amount: "100.00",
        currency: "BRL",
      }),
      balanceAfter: Money.from({
        amount: "75.00",
        currency: "BRL",
      }),
      createdAt: originalDate,
    });

    // Tentamos modificar a data original
    originalDate.setFullYear(2000);

    // Tentamos modificar a data retornada pelo getter
    entry.createdAt.setFullYear(1990);

    // A data interna deve continuar intacta
    expect(entry.createdAt.getUTCFullYear()).toBe(2026);
  });
});