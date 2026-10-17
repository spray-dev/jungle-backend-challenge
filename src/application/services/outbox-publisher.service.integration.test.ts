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

import type {
    IntegrationEventEnvelope,
} from "../../domain/events/integration-event.js";

import type {
    IntegrationEventPublisher,
} from "../../domain/ports/integration-event-publisher.js";

import {
    OutboxMessage,
} from "../../domain/outbox-message.js";

import {
    MikroOrmOutboxMessageRepository,
} from "../../persistence/repositories/mikro-orm-outbox-message.repository.js";

import {
    OutboxPublisherService,
} from "./outbox-publisher.service.js";

let orm: MikroORM;

beforeAll(async () => {
    orm = await createTestOrm();
}, 30000);

afterAll(async () => {
    await closeTestOrm(orm);
});

function createMessage():
    OutboxMessage {

    const id =
        crypto.randomUUID();

    const now =
        new Date();

    return OutboxMessage.rehydrate({
        id,

        eventType:
            "TestEvent",

        eventVersion: 1,

        payload: {
            messageId: id,
            type: "TestEvent",
            version: 1,
            occurredAt:
                now.toISOString(),

            data: {
                value: "test",
            },
        },

        createdAt: now,
        attempts: 0,
        nextAttemptAt: now,
    });
}

it("publishes a pending outbox message and marks it published", async () => {
    const message =
        createMessage();

    await new MikroOrmOutboxMessageRepository(
        orm.em.fork(),
    ).insert(
        message,
    );

    const published:
        IntegrationEventEnvelope<unknown>[] =
        [];

    const publisher:
        IntegrationEventPublisher = {
        async publish(event) {
            published.push(
                event,
            );
        },
    };

    const result =
        await new OutboxPublisherService(
            orm.em.fork(),
            publisher,
        ).publishPending();

    expect(result)
        .toEqual({
            processed: 1,
            published: 1,
            failed: 0,
        });

    expect(published)
        .toHaveLength(1);

    expect(
        published[0]?.messageId,
    ).toBe(
        message.id,
    );

    const stored =
        await new MikroOrmOutboxMessageRepository(
            orm.em.fork(),
        ).findById(
            message.id,
        );

    expect(stored)
        .not.toBeNull();

    expect(
        stored?.isPublished(),
    ).toBe(true);

    expect(
        stored?.attempts,
    ).toBe(0);
});

it("schedules exponential retry when publication fails", async () => {
    const message =
        createMessage();

    await new MikroOrmOutboxMessageRepository(
        orm.em.fork(),
    ).insert(
        message,
    );

    const publisher:
        IntegrationEventPublisher = {
        async publish() {
            throw new Error(
                "broker unavailable",
            );
        },
    };

    const before =
        Date.now();

    const result =
        await new OutboxPublisherService(
            orm.em.fork(),
            publisher,
            60_000,
            300_000,
        ).publishPending();

    expect(result)
        .toEqual({
            processed: 1,
            published: 0,
            failed: 1,
        });

    const stored =
        await new MikroOrmOutboxMessageRepository(
            orm.em.fork(),
        ).findById(
            message.id,
        );

    expect(stored)
        .not.toBeNull();

    expect(
        stored?.isPublished(),
    ).toBe(false);

    expect(
        stored?.attempts,
    ).toBe(1);

    expect(
        stored!.nextAttemptAt.getTime(),
    ).toBeGreaterThanOrEqual(
        before + 60_000,
    );

    /*
     * Como nextAttemptAt está no futuro,
     * uma execução imediata não deve
     * tentar publicar novamente.
     */
    const immediate =
        await new OutboxPublisherService(
            orm.em.fork(),
            publisher,
            60_000,
            300_000,
        ).publishPending();

    expect(immediate.processed)
        .toBe(0);
});

it("prevents concurrent publishers from publishing the same message simultaneously", async () => {
    const message =
        createMessage();

    await new MikroOrmOutboxMessageRepository(
        orm.em.fork(),
    ).insert(
        message,
    );

    let publishCalls = 0;

    let signalStarted:
        (() => void) | undefined;

    const started =
        new Promise<void>(
            resolve => {
                signalStarted =
                    resolve;
            },
        );

    let releasePublish:
        (() => void) | undefined;

    const release =
        new Promise<void>(
            resolve => {
                releasePublish =
                    resolve;
            },
        );

    const publisher:
        IntegrationEventPublisher = {
        async publish() {
            publishCalls += 1;

            signalStarted?.();

            /*
             * Mantém Worker A parado
             * depois de adquirir o lock.
             */
            await release;
        },
    };

    const workerA =
        new OutboxPublisherService(
            orm.em.fork(),
            publisher,
        );

    const workerB =
        new OutboxPublisherService(
            orm.em.fork(),
            publisher,
        );

    const workerAPromise =
        workerA.publishPending(1);

    /*
     * Só inicia B depois que A
     * já pegou a mensagem.
     */
    await started;

    const workerBResult =
        await workerB.publishPending(1);

    expect(
        workerBResult.processed,
    ).toBe(0);

    expect(
        publishCalls,
    ).toBe(1);

    releasePublish?.();

    const workerAResult =
        await workerAPromise;

    expect(
        workerAResult.published,
    ).toBe(1);

    expect(
        publishCalls,
    ).toBe(1);

    const stored =
        await new MikroOrmOutboxMessageRepository(
            orm.em.fork(),
        ).findById(
            message.id,
        );

    expect(
        stored?.isPublished(),
    ).toBe(true);
});