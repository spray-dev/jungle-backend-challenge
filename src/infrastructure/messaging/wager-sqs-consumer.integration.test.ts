import {
    afterAll,
    beforeAll,
    expect,
    it,
} from "bun:test";

import {
    CreateQueueCommand,
    DeleteQueueCommand,
    GetQueueAttributesCommand,
    ReceiveMessageCommand,
    SendMessageCommand,
    SQSClient,
} from "@aws-sdk/client-sqs";

import {
    MikroORM,
} from "@mikro-orm/postgresql";

import {
    createTestOrm,
    closeTestOrm,
} from "../../testing/integration-database.js";

import {
    Money,
} from "../../domain/money.js";

import {
    Wallet,
} from "../../domain/wallet.js";

import {
    MikroOrmWalletRepository,
} from "../../persistence/repositories/mikro-orm-wallet.repository.js";

import {
    WagerSqsConsumer,
} from "./wager-sqs-consumer.js";

import { createHash } from "node:crypto";

import {
    ChangeMessageVisibilityCommand,
} from "@aws-sdk/client-sqs";

import {
    HandleWagerMessageService,
} from "../../application/services/handle-wager-message.service.js";

let orm: MikroORM;
let client: SQSClient;

let queueUrl: string;
let dlqUrl: string;

beforeAll(async () => {
    orm =
        await createTestOrm();

    client =
        new SQSClient({
            region:
                "us-east-1",

            endpoint:
                "http://localhost:4566",

            credentials: {
                accessKeyId:
                    "test",

                secretAccessKey:
                    "test",
            },
        });

    const suffix =
        crypto.randomUUID()
            .replaceAll("-", "");

    const dlq =
        await client.send(
            new CreateQueueCommand({
                QueueName:
                    `consumer-dlq-${suffix}.fifo`,

                Attributes: {
                    FifoQueue:
                        "true",

                    ContentBasedDeduplication:
                        "false",
                },
            }),
        );

    dlqUrl =
        dlq.QueueUrl!;

    const attrs =
        await client.send(
            new GetQueueAttributesCommand({
                QueueUrl:
                    dlqUrl,

                AttributeNames: [
                    "QueueArn",
                ],
            }),
        );

    const queue =
        await client.send(
            new CreateQueueCommand({
                QueueName:
                    `consumer-${suffix}.fifo`,

                Attributes: {
                    FifoQueue:
                        "true",

                    ContentBasedDeduplication:
                        "false",

                    VisibilityTimeout:
                        "1",

                    RedrivePolicy:
                        JSON.stringify({
                            deadLetterTargetArn:
                                attrs.Attributes!
                                    .QueueArn!,

                            maxReceiveCount:
                                5,
                        }),
                },
            }),
        );

    queueUrl =
        queue.QueueUrl!;
}, 30000);

afterAll(async () => {
    if (queueUrl) {
        await client.send(
            new DeleteQueueCommand({
                QueueUrl:
                    queueUrl,
            }),
        );
    }

    if (dlqUrl) {
        await client.send(
            new DeleteQueueCommand({
                QueueUrl:
                    dlqUrl,
            }),
        );
    }

    client.destroy();

    await closeTestOrm(
        orm,
    );
});

it("processes a real SQS wager and acknowledges only after commit", async () => {
    const walletId =
        crypto.randomUUID();

    const playerId =
        crypto.randomUUID();

    await new MikroOrmWalletRepository(
        orm.em.fork(),
    ).create(
        Wallet.open({
            id:
                walletId,

            playerId,

            initialBalance:
                Money.from({
                    amount:
                        "100.00",

                    currency:
                        "BRL",
                }),
        }),
    );

    const messageId =
        crypto.randomUUID();

    const externalTransactionId =
        crypto.randomUUID();

    const body =
        JSON.stringify({
            messageId,

            type:
                "WagerTransactionRequested",

            occurredAt:
                new Date().toISOString(),

            data: {
                providerId:
                    "provider-a",

                externalTransactionId,

                idempotencyKey:
                    `provider-a:${externalTransactionId}`,

                playerId,
                walletId,

                roundId:
                    "round-1",

                gameId:
                    "game-1",

                kind:
                    "BET",

                money: {
                    amount:
                        "20.00",

                    currency:
                        "BRL",
                },
            },
        });

    await client.send(
        new SendMessageCommand({
            QueueUrl:
                queueUrl,

            MessageBody:
                body,

            MessageGroupId:
                walletId,

            MessageDeduplicationId:
                messageId,
        }),
    );

    const result =
        await new WagerSqsConsumer(
            client,
            queueUrl,
            orm.em.fork(),
        ).pollOnce();

    expect(result)
        .toBe("ACKED");

    /*
     * Se o ACK aconteceu,
     * a mensagem não deve mais estar na fila.
     */
    const remaining =
        await client.send(
            new ReceiveMessageCommand({
                QueueUrl:
                    queueUrl,

                MaxNumberOfMessages:
                    1,

                WaitTimeSeconds:
                    1,
            }),
        );

    expect(
        remaining.Messages ??
        [],
    ).toHaveLength(0);

    const wallets =
        await orm.em
            .getConnection()
            .execute(
                `
                    select balance, version
                    from wallets
                    where id = ?
                `,
                [
                    walletId,
                ],
            );

    expect(
        wallets[0]?.balance,
    ).toBe("80.00");

    expect(
        wallets[0]?.version,
    ).toBe(2);

    const wagers =
        await orm.em
            .getConnection()
            .execute(
                `
                    select status
                    from wager_transactions
                    where provider_id = ?
                      and external_transaction_id = ?
                `,
                [
                    "provider-a",
                    externalTransactionId,
                ],
            );

    expect(wagers)
        .toHaveLength(1);

    expect(
        wagers[0]?.status,
    ).toBe("PROCESSED");

    const ledger =
        await orm.em
            .getConnection()
            .execute(
                `
                    select id
                    from wallet_ledger_entries
                    where wallet_id = ?
                `,
                [
                    walletId,
                ],
            );

    expect(ledger)
        .toHaveLength(1);

    const inbox =
        await orm.em
            .getConnection()
            .execute(
                `
                    select processed_at
                    from inbox_messages
                    where consumer_name = ?
                      and message_id = ?
                `,
                [
                    "wager-transactions-consumer",
                    messageId,
                ],
            );

    expect(inbox)
        .toHaveLength(1);

    expect(
        inbox[0]?.processed_at,
    ).not.toBeNull();

    const outbox =
        await orm.em
            .getConnection()
            .execute(
                `
                    select id
                    from outbox_messages
                    where payload
                        -> 'data'
                        ->> 'externalTransactionId'
                        = ?
                `,
                [
                    externalTransactionId,
                ],
            );

    expect(outbox)
        .toHaveLength(1);
});

it("survives redelivery after commit before ack without duplicating financial effects", async () => {
    const walletId =
        crypto.randomUUID();

    const playerId =
        crypto.randomUUID();

    await new MikroOrmWalletRepository(
        orm.em.fork(),
    ).create(
        Wallet.open({
            id: walletId,
            playerId,

            initialBalance:
                Money.from({
                    amount: "100.00",
                    currency: "BRL",
                }),
        }),
    );

    const messageId =
        crypto.randomUUID();

    const externalTransactionId =
        crypto.randomUUID();

    const body =
        JSON.stringify({
            messageId,

            type:
                "WagerTransactionRequested",

            occurredAt:
                new Date().toISOString(),

            data: {
                providerId:
                    "provider-a",

                externalTransactionId,

                idempotencyKey:
                    `provider-a:${externalTransactionId}`,

                playerId,
                walletId,

                roundId:
                    "round-redelivery",

                gameId:
                    "game-redelivery",

                kind:
                    "BET",

                money: {
                    amount: "20.00",
                    currency: "BRL",
                },
            },
        });

    await client.send(
        new SendMessageCommand({
            QueueUrl:
                queueUrl,

            MessageBody:
                body,

            MessageGroupId:
                walletId,

            MessageDeduplicationId:
                messageId,
        }),
    );

    /*
     * Worker A recebe a mensagem...
     */
    const firstDelivery =
        await client.send(
            new ReceiveMessageCommand({
                QueueUrl:
                    queueUrl,

                MaxNumberOfMessages:
                    1,

                WaitTimeSeconds:
                    1,
            }),
        );

    const received =
        firstDelivery.Messages?.[0];

    expect(received)
        .toBeDefined();

    /*
     * ...processa e COMMITA no PostgreSQL...
     */
    const payloadHash =
        createHash("sha256")
            .update(body)
            .digest("hex");

    await new HandleWagerMessageService(
        orm.em.fork(),
    ).execute({
        consumerName:
            "wager-transactions-consumer",

        messageId,

        payloadHash,

        wager: {
            providerId:
                "provider-a",

            externalTransactionId,

            idempotencyKey:
                `provider-a:${externalTransactionId}`,

            playerId,
            walletId,

            roundId:
                "round-redelivery",

            gameId:
                "game-redelivery",

            money: {
                amount: "20.00",
                currency: "BRL",
            },
        },
    });

    /*
     * ...mas "morre" antes de DeleteMessage.
     *
     * VisibilityTimeout = 0 simula a mensagem
     * voltando imediatamente para outro worker.
     */
    await client.send(
        new ChangeMessageVisibilityCommand({
            QueueUrl:
                queueUrl,

            ReceiptHandle:
                received!.ReceiptHandle!,

            VisibilityTimeout:
                0,
        }),
    );

    /*
     * Worker B recebe a mesma mensagem.
     */
    const secondResult =
        await new WagerSqsConsumer(
            client,
            queueUrl,
            orm.em.fork(),
        ).pollOnce();

    expect(secondResult)
        .toBe("ACKED");

    /*
     * O importante:
     * nada financeiro pode ter duplicado.
     */
    const walletRows =
        await orm.em
            .getConnection()
            .execute(
                `
                    select balance, version
                    from wallets
                    where id = ?
                `,
                [
                    walletId,
                ],
            );

    expect(
        walletRows[0]?.balance,
    ).toBe("80.00");

    expect(
        walletRows[0]?.version,
    ).toBe(2);

    const ledgerRows =
        await orm.em
            .getConnection()
            .execute(
                `
                    select id
                    from wallet_ledger_entries
                    where wallet_id = ?
                `,
                [
                    walletId,
                ],
            );

    expect(ledgerRows)
        .toHaveLength(1);

    const wagerRows =
        await orm.em
            .getConnection()
            .execute(
                `
                    select id
                    from wager_transactions
                    where provider_id = ?
                      and external_transaction_id = ?
                `,
                [
                    "provider-a",
                    externalTransactionId,
                ],
            );

    expect(wagerRows)
        .toHaveLength(1);

    const inboxRows =
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
                    "wager-transactions-consumer",
                    messageId,
                ],
            );

    expect(inboxRows)
        .toHaveLength(1);

    const outboxRows =
        await orm.em
            .getConnection()
            .execute(
                `
                    select id
                    from outbox_messages
                    where payload
                        -> 'data'
                        ->> 'externalTransactionId'
                        = ?
                `,
                [
                    externalTransactionId,
                ],
            );

    expect(outboxRows)
        .toHaveLength(1);
});

it("moves a permanently invalid message to the DLQ after repeated deliveries", async () => {
    const messageId =
        crypto.randomUUID();

    const body =
        JSON.stringify({
            messageId,

            type:
                "SomethingUnsupported",

            occurredAt:
                new Date().toISOString(),

            data: {},
        });

    await client.send(
        new SendMessageCommand({
            QueueUrl:
                queueUrl,

            MessageBody:
                body,

            MessageGroupId:
                "invalid-message",

            MessageDeduplicationId:
                messageId,
        }),
    );

    const consumer =
        new WagerSqsConsumer(
            client,
            queueUrl,
            orm.em.fork(),
        );

    /*
     * RedrivePolicy da fila:
     * maxReceiveCount = 5.
     *
     * Fazemos algumas polls extras porque
     * a mudança para a DLQ é responsabilidade
     * do broker.
     */
    for (
        let attempt = 0;
        attempt < 7;
        attempt++
    ) {
        await consumer.pollOnce();
    }

    let receivedFromDlq: any;

    for (
        let attempt = 0;
        attempt < 5;
        attempt++
    ) {
        const response =
            await client.send(
                new ReceiveMessageCommand({
                    QueueUrl:
                        dlqUrl,

                    MaxNumberOfMessages:
                        1,

                    WaitTimeSeconds:
                        1,
                }),
            );

        if (
            response.Messages?.[0]
        ) {
            receivedFromDlq =
                response.Messages[0];

            break;
        }
    }

    expect(receivedFromDlq)
        .toBeDefined();

    expect(
        receivedFromDlq.Body,
    ).toBe(body);
});
for (const kind of ["WIN", "LOSS"] as const) {
    it(`processes ${kind} through real SQS and deduplicates a new delivery identity`, async () => {
        const walletId = crypto.randomUUID();
        await new MikroOrmWalletRepository(orm.em.fork()).create(Wallet.open({
            id: walletId, playerId: walletId,
            initialBalance: Money.from({ amount: "100.00", currency: "BRL" }),
        }));
        const externalTransactionId = crypto.randomUUID();
        for (let delivery = 0; delivery < 2; delivery++) {
            const messageId = crypto.randomUUID();
            await client.send(new SendMessageCommand({
                QueueUrl: queueUrl, MessageGroupId: walletId, MessageDeduplicationId: messageId,
                MessageBody: JSON.stringify({
                    messageId, type: "WagerTransactionRequested", occurredAt: new Date().toISOString(),
                    data: { providerId: "new-kinds", externalTransactionId, idempotencyKey: externalTransactionId,
                        playerId: walletId, walletId, roundId: "round", gameId: "game", kind,
                        money: { amount: "200.00", currency: "BRL" } },
                }),
            }));
            expect(await new WagerSqsConsumer(client, queueUrl, orm.em.fork()).pollOnce()).toBe("ACKED");
        }
        const wallet = await new MikroOrmWalletRepository(orm.em.fork()).findById(walletId);
        expect(wallet?.balance.toJSON().amount).toBe(kind === "WIN" ? "300.00" : "100.00");
        expect(wallet?.version).toBe(kind === "WIN" ? 2 : 1);
        const ledger = await orm.em.getConnection().execute("select * from wallet_ledger_entries where wallet_id = ?", [walletId]);
        expect(ledger).toHaveLength(kind === "WIN" ? 1 : 0);
        if (kind === "WIN") expect(ledger[0]?.direction).toBe("CREDIT");
        const wagers = await orm.em.getConnection().execute("select * from wager_transactions where wallet_id = ?", [walletId]);
        expect(wagers).toHaveLength(1);
        expect(wagers[0]).toMatchObject({ kind, status: "PROCESSED" });
        const events = await orm.em.getConnection().execute("select * from outbox_messages where payload->'data'->>'walletId' = ?", [walletId]);
        expect(events).toHaveLength(1);
        expect(events[0]?.payload.data.kind).toBe(kind);
    });
}
