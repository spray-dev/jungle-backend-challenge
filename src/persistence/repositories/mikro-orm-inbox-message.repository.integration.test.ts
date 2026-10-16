import {
    afterAll,
    beforeAll,
    expect,
    it,
} from "bun:test";

import { MikroORM } from "@mikro-orm/postgresql";

import { InboxMessage } from "../../domain/inbox-message.js";
import {
    createTestOrm,
    closeTestOrm,
} from "../../testing/integration-database.js";

import { MikroOrmInboxMessageRepository } from "./mikro-orm-inbox-message.repository.js";

let orm: MikroORM;

beforeAll(async () => {
    orm = await createTestOrm();
}, 30000);

afterAll(async () => {
    await closeTestOrm(orm);
});

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

function message(
    messageId = crypto.randomUUID(),
    consumerName = "wager-transactions-consumer",
    payloadHash = HASH_A,
): InboxMessage {
    return InboxMessage.receive({
        messageId,
        consumerName,
        payloadHash,
        receivedAt: new Date(),
    });
}

it("inserts and retrieves an inbox message", async () => {
    const inbox = message();

    const repository =
        new MikroOrmInboxMessageRepository(
            orm.em.fork(),
        );

    expect(
        await repository.tryInsert(inbox),
    ).toBe(true);

    const persisted =
        await repository.findByIdentity(
            inbox.consumerName,
            inbox.messageId,
        );

    expect(persisted).not.toBeNull();

    expect(persisted?.messageId)
        .toBe(inbox.messageId);

    expect(persisted?.consumerName)
        .toBe(inbox.consumerName);

    expect(persisted?.payloadHash)
        .toBe(HASH_A);

    expect(persisted?.isProcessed())
        .toBe(false);
});

it("returns false when the same consumer receives the same message again", async () => {
    const inbox = message();

    const repository =
        new MikroOrmInboxMessageRepository(
            orm.em.fork(),
        );

    expect(
        await repository.tryInsert(inbox),
    ).toBe(true);

    expect(
        await repository.tryInsert(inbox),
    ).toBe(false);

    const rows =
        await orm.em
            .getConnection()
            .execute(
                `
                    select *
                    from inbox_messages
                    where consumer_name = ?
                      and message_id = ?
                `,
                [
                    inbox.consumerName,
                    inbox.messageId,
                ],
            );

    expect(rows).toHaveLength(1);
});

it("allows the same messageId for different consumers", async () => {
    const messageId = crypto.randomUUID();

    const consumerA = message(
        messageId,
        "consumer-a",
    );

    const consumerB = message(
        messageId,
        "consumer-b",
    );

    const repository =
        new MikroOrmInboxMessageRepository(
            orm.em.fork(),
        );

    expect(
        await repository.tryInsert(consumerA),
    ).toBe(true);

    expect(
        await repository.tryInsert(consumerB),
    ).toBe(true);

    const rows =
        await orm.em
            .getConnection()
            .execute(
                `
                    select consumer_name
                    from inbox_messages
                    where message_id = ?
                `,
                [messageId],
            );

    expect(rows).toHaveLength(2);
});

it("does not overwrite the original payload when identity is duplicated", async () => {
    const messageId = crypto.randomUUID();

    const original = message(
        messageId,
        "consumer",
        HASH_A,
    );

    const conflicting = message(
        messageId,
        "consumer",
        HASH_B,
    );

    const repository =
        new MikroOrmInboxMessageRepository(
            orm.em.fork(),
        );

    expect(
        await repository.tryInsert(original),
    ).toBe(true);

    expect(
        await repository.tryInsert(conflicting),
    ).toBe(false);

    const persisted =
        await repository.findByIdentity(
            "consumer",
            messageId,
        );

    expect(persisted?.payloadHash)
        .toBe(HASH_A);
});

it("allows exactly one concurrent insert for the same inbox identity", async () => {
    const inbox = message();

    const results =
        await Promise.all(
            Array.from(
                { length: 50 },
                async () => {
                    const repository =
                        new MikroOrmInboxMessageRepository(
                            orm.em.fork(),
                        );

                    return repository.tryInsert(
                        inbox,
                    );
                },
            ),
        );

    expect(
        results.filter(Boolean),
    ).toHaveLength(1);

    const rows =
        await orm.em
            .getConnection()
            .execute(
                `
                    select *
                    from inbox_messages
                    where consumer_name = ?
                      and message_id = ?
                `,
                [
                    inbox.consumerName,
                    inbox.messageId,
                ],
            );

    expect(rows).toHaveLength(1);
});

it("persists processedAt once", async () => {
    const inbox = message();

    const repository =
        new MikroOrmInboxMessageRepository(
            orm.em.fork(),
        );

    await repository.tryInsert(inbox);

    const processedAt = new Date();

    inbox.markProcessed(processedAt);

    await repository.markProcessed(inbox);

    const persisted =
        await repository.findByIdentity(
            inbox.consumerName,
            inbox.messageId,
        );

    expect(persisted?.isProcessed())
        .toBe(true);

    expect(
        persisted?.processedAt?.getTime(),
    ).toBe(processedAt.getTime());
});