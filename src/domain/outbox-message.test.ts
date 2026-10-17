import {
    expect,
    it,
} from "bun:test";

import {
    OutboxMessage,
} from "./outbox-message.js";

function message():
    OutboxMessage {
    const createdAt =
        new Date(
            "2026-10-16T12:00:00.000Z",
        );

    return OutboxMessage.rehydrate({
        id:
            crypto.randomUUID(),

        eventType:
            "WagerTransactionProcessed",

        eventVersion: 1,

        payload: {
            messageId:
                crypto.randomUUID(),

            type:
                "WagerTransactionProcessed",

            version: 1,

            occurredAt:
                createdAt.toISOString(),

            data: {},
        },

        createdAt,

        attempts: 0,

        nextAttemptAt:
            createdAt,
    });
}

it("marks an outbox message as published", () => {
    const outbox =
        message();

    const publishedAt =
        new Date(
            "2026-10-16T12:01:00.000Z",
        );

    outbox.markPublished(
        publishedAt,
    );

    expect(
        outbox.isPublished(),
    ).toBe(true);

    expect(
        outbox.publishedAt
            ?.toISOString(),
    ).toBe(
        publishedAt.toISOString(),
    );
});

it("schedules an outbox retry and increments attempts", () => {
    const outbox =
        message();

    const retryAt =
        new Date(
            "2026-10-16T12:05:00.000Z",
        );

    outbox.scheduleRetry(
        retryAt,
    );

    expect(
        outbox.attempts,
    ).toBe(1);

    expect(
        outbox.nextAttemptAt
            .toISOString(),
    ).toBe(
        retryAt.toISOString(),
    );
});

it("does not allow retry after publication", () => {
    const outbox =
        message();

    outbox.markPublished(
        new Date(),
    );

    expect(
        () =>
            outbox.scheduleRetry(
                new Date(),
            ),
    ).toThrow(
        "Cannot retry a published outbox message",
    );
});