import { describe, expect, it } from "bun:test";

import { Money } from "./money.js";
import {
    FailureCode,
    WagerTransaction,
    WagerTransactionKind,
    WagerTransactionStatus,
} from "./wager-transaction.js";

function money(amount = "20.00"): Money {
    return Money.from({
        amount,
        currency: "BRL",
    });
}

function createTransaction(
    kind: WagerTransactionKind,
    referenceExternalTransactionId?: string,
): WagerTransaction {
    return WagerTransaction.create({
        id: crypto.randomUUID(),
        providerId: "provider-1",
        externalTransactionId: crypto.randomUUID(),
        idempotencyKey: crypto.randomUUID(),
        payloadHash: "hash-123",
        walletId: crypto.randomUUID(),
        playerId: "player-1",
        roundId: "round-1",
        gameId: "game-1",
        kind,
        money: money(),
        referenceExternalTransactionId,
        createdAt: new Date(),
    });
}

describe("WagerTransaction", () => {
    it("starts in PENDING status", () => {
        const transaction = createTransaction(
            WagerTransactionKind.Bet,
        );

        expect(transaction.status)
            .toBe(WagerTransactionStatus.Pending);
    });

    it("BET produces a DEBIT ledger direction", () => {
        const transaction = createTransaction(
            WagerTransactionKind.Bet,
        );

        expect(transaction.ledgerDirectionFor())
            .toBe("DEBIT");
    });

    it("WIN produces a CREDIT ledger direction", () => {
        const transaction = createTransaction(
            WagerTransactionKind.Win,
        );

        expect(transaction.ledgerDirectionFor())
            .toBe("CREDIT");
    });

    it("LOSS does not produce a ledger entry", () => {
        const transaction = createTransaction(
            WagerTransactionKind.Loss,
        );

        expect(transaction.affectsBalance()).toBe(false);

        expect(() => transaction.ledgerDirectionFor())
            .toThrow("LOSS does not produce a ledger entry");
    });

    it("REFUND requires a reference transaction", () => {
        expect(() =>
            createTransaction(WagerTransactionKind.Refund),
        ).toThrow("REFUND requires a reference transaction");
    });

    it("ROLLBACK reverses a BET direction", () => {
        const bet = createTransaction(
            WagerTransactionKind.Bet,
        );

        const rollback = createTransaction(
            WagerTransactionKind.Rollback,
            bet.externalTransactionId,
        );

        expect(rollback.ledgerDirectionFor(bet))
            .toBe("CREDIT");
    });

    it("ROLLBACK reverses a WIN direction", () => {
        const win = createTransaction(
            WagerTransactionKind.Win,
        );

        const rollback = createTransaction(
            WagerTransactionKind.Rollback,
            win.externalTransactionId,
        );

        expect(rollback.ledgerDirectionFor(win))
            .toBe("DEBIT");
    });

    it("cannot change a processed transaction again", () => {
        const transaction = createTransaction(
            WagerTransactionKind.Bet,
        );

        transaction.markProcessed(
            undefined,
            new Date(),
        );

        expect(transaction.status)
            .toBe(WagerTransactionStatus.Processed);

        expect(() =>
            transaction.reject(
                FailureCode.InsufficientFunds,
            ),
        ).toThrow(
            "Transaction in status PROCESSED is terminal",
        );
    });
});