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
    SQSClient,
} from "@aws-sdk/client-sqs";

import {
    SqsIntegrationEventPublisher,
} from "./sqs-integration-event.publisher.js";

let client: SQSClient;

let queueUrl: string;
let dlqUrl: string;

beforeAll(async () => {
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
                    `wager-transactions-dlq-${suffix}.fifo`,

                Attributes: {
                    FifoQueue:
                        "true",

                    ContentBasedDeduplication:
                        "false",
                },
            }),
        );

    if (!dlq.QueueUrl) {
        throw new Error(
            "LocalStack did not return DLQ URL",
        );
    }

    dlqUrl =
        dlq.QueueUrl;

    const attributes =
        await client.send(
            new GetQueueAttributesCommand({
                QueueUrl:
                    dlqUrl,

                AttributeNames: [
                    "QueueArn",
                ],
            }),
        );

    const dlqArn =
        attributes.Attributes
            ?.QueueArn;

    if (!dlqArn) {
        throw new Error(
            "LocalStack did not return DLQ ARN",
        );
    }

    const queue =
        await client.send(
            new CreateQueueCommand({
                QueueName:
                    `wager-transactions-${suffix}.fifo`,

                Attributes: {
                    FifoQueue:
                        "true",

                    ContentBasedDeduplication:
                        "false",

                    RedrivePolicy:
                        JSON.stringify({
                            deadLetterTargetArn:
                                dlqArn,

                            maxReceiveCount:
                                5,
                        }),
                },
            }),
        );

    if (!queue.QueueUrl) {
        throw new Error(
            "LocalStack did not return queue URL",
        );
    }

    queueUrl =
        queue.QueueUrl;
});

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
});

it("publishes an integration event to a real FIFO SQS queue", async () => {
    const publisher =
        new SqsIntegrationEventPublisher(
            client,
            queueUrl,
        );

    const messageId =
        crypto.randomUUID();

    const walletId =
        crypto.randomUUID();

    const event = {
        messageId,

        type:
            "WagerTransactionProcessed",

        version: 1,

        occurredAt:
            new Date().toISOString(),

        data: {
            transactionId:
                crypto.randomUUID(),

            walletId,

            amount:
                "20.00",

            currency:
                "BRL",
        },
    };

    await publisher.publish(
        event,
    );

    const received =
        await client.send(
            new ReceiveMessageCommand({
                QueueUrl:
                    queueUrl,

                MaxNumberOfMessages:
                    1,

                WaitTimeSeconds:
                    2,

                AttributeNames: [
                    "All",
                ],
            }),
        );

    expect(
        received.Messages,
    ).toHaveLength(1);

    const message =
        received.Messages?.[0];

    expect(message)
        .toBeDefined();

    expect(
        JSON.parse(
            message!.Body!,
        ),
    ).toEqual(
        event,
    );

    expect(
        message!.Attributes
            ?.MessageGroupId,
    ).toBe(
        walletId,
    );

    expect(
        message!.Attributes
            ?.MessageDeduplicationId,
    ).toBe(
        messageId,
    );
});