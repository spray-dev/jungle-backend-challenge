import {
    afterAll,
    beforeAll,
    expect,
    it,
} from "bun:test";

import {
    MikroORM,
} from "@mikro-orm/postgresql";

import {
    createTestOrm,
    closeTestOrm,
} from "../../testing/integration-database.js";

import { Money } from "../../domain/money.js";

import {
    WagerTransaction,
    WagerTransactionKind,
} from "../../domain/wager-transaction.js";

import {
    WagerTransactionProcessedEvent,
} from "../../domain/events/wager-transaction-processed.event.js";

import {
    OutboxMessage,
} from "../../domain/outbox-message.js";

import {
    MikroOrmOutboxMessageRepository,
} from "./mikro-orm-outbox-message.repository.js";

let orm: MikroORM;

beforeAll(async () => {
    orm = await createTestOrm();
}, 30000);

afterAll(async () => {
    await closeTestOrm(orm);
});

function createOutboxMessage():
    OutboxMessage {

    const transaction =
        WagerTransaction.create({
            id: crypto.randomUUID(),

            providerId:
                "provider",

            externalTransactionId:
                crypto.randomUUID(),

            idempotencyKey:
                crypto.randomUUID(),

            payloadHash:
                "a".repeat(64),

            walletId:
                crypto.randomUUID(),

            playerId:
                "player",

            roundId:
                "round",

            gameId:
                "game",

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
        new Date();

    transaction.markProcessed(
        undefined,
        occurredAt,
        Money.from({
            amount: "80.00",
            currency: "BRL",
        }),
    );

    const event =
        new WagerTransactionProcessedEvent(
            crypto.randomUUID(),
            occurredAt,
            transaction,
        );

    return OutboxMessage.fromEvent(
        event,
        occurredAt,
    );
}

it("persists and reloads an outbox message", async () => {
    const message =
        createOutboxMessage();

    const repository =
        new MikroOrmOutboxMessageRepository(
            orm.em.fork(),
        );

    await repository.insert(
        message,
    );

    const stored =
        await repository.findById(
            message.id,
        );

    expect(stored)
        .not.toBeNull();

    expect(stored?.id)
        .toBe(message.id);

    expect(stored?.eventType)
        .toBe(
            "WagerTransactionProcessed",
        );

    expect(stored?.eventVersion)
        .toBe(1);

    expect(stored?.attempts)
        .toBe(0);

    expect(stored?.publishedAt)
        .toBeUndefined();

    expect(stored?.payload)
        .toEqual(message.payload);

    expect(
        stored?.nextAttemptAt.getTime(),
    ).toBe(
        message.nextAttemptAt.getTime(),
    );
});

it("participates in an outer transaction and rolls back with it", async () => {
    const message =
        createOutboxMessage();

    await expect(
        orm.em.fork().transactional(
            async tx => {
                const repository =
                    new MikroOrmOutboxMessageRepository(
                        tx,
                    );

                await repository.insert(
                    message,
                );

                /*
                 * Ainda dentro da transaction,
                 * a linha precisa existir.
                 */
                const inside =
                    await repository.findById(
                        message.id,
                    );

                expect(inside)
                    .not.toBeNull();

                throw new Error(
                    "outer transaction failed",
                );
            },
        ),
    ).rejects.toThrow(
        "outer transaction failed",
    );

    /*
     * Depois do rollback,
     * ela não pode existir.
     */
    const stored =
        await new MikroOrmOutboxMessageRepository(
            orm.em.fork(),
        ).findById(
            message.id,
        );

    expect(stored)
        .toBeNull();
});