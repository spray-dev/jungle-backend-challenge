import {
    expect,
    it,
} from "bun:test";

import { Money } from "../money.js";

import {
    WagerTransaction,
    WagerTransactionKind,
} from "../wager-transaction.js";

import {
    WagerTransactionProcessedEvent,
} from "./wager-transaction-processed.event.js";

it("serializes a processed wager into a stable integration event envelope", () => {
    const transaction =
        WagerTransaction.create({
            id: crypto.randomUUID(),

            providerId: "provider",
            externalTransactionId: "external",
            idempotencyKey: "key",
            payloadHash: "hash",

            walletId:
                crypto.randomUUID(),

            playerId: "player",

            roundId: "round",
            gameId: "game",

            kind:
                WagerTransactionKind.Bet,

            money:
                Money.from({
                    amount: "20.00",
                    currency: "BRL",
                }),

            createdAt:
                new Date(),
        });

    const occurredAt =
        new Date(
            "2026-10-16T12:00:00.000Z",
        );

    transaction.markProcessed(
        undefined,
        occurredAt,
        Money.from({
            amount: "80.00",
            currency: "BRL",
        }),
    );

    const messageId =
        crypto.randomUUID();

    const event =
        new WagerTransactionProcessedEvent(
            messageId,
            occurredAt,
            transaction,
        );

    expect(
        event.toEnvelope(),
    ).toEqual({
        messageId,

        type:
            "WagerTransactionProcessed",

        version: 1,

        occurredAt:
            "2026-10-16T12:00:00.000Z",

        data: {
            transactionId:
                transaction.id,

            providerId:
                "provider",

            externalTransactionId:
                "external",

            idempotencyKey:
                "key",

            walletId:
                transaction.walletId,

            playerId:
                "player",

            roundId:
                "round",

            gameId:
                "game",

            kind:
                "BET",

            money: {
                amount: "20.00",
                currency: "BRL",
            },

            balance: {
                amount: "80.00",
                currency: "BRL",
            },
        },
    });
});