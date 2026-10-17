import {
    SendMessageCommand,
    type SQSClient,
} from "@aws-sdk/client-sqs";

import type {
    IntegrationEventEnvelope,
} from "../../domain/events/integration-event.js";

import type {
    IntegrationEventPublisher,
} from "../../domain/ports/integration-event-publisher.js";

export class SqsIntegrationEventPublisher
    implements IntegrationEventPublisher {

    constructor(
        private readonly client:
            SQSClient,

        private readonly queueUrl:
            string,
    ) {}

    async publish(
        event: IntegrationEventEnvelope<unknown>,
    ): Promise<void> {
        const messageGroupId =
            this.resolveMessageGroupId(
                event,
            );

        await this.client.send(
            new SendMessageCommand({
                QueueUrl:
                    this.queueUrl,

                MessageBody:
                    JSON.stringify(
                        event,
                    ),

                /*
                 * FIFO mantém ordem dentro
                 * da mesma wallet.
                 *
                 * Wallets diferentes continuam
                 * podendo ser processadas
                 * em paralelo.
                 */
                MessageGroupId:
                    messageGroupId,

                /*
                 * Camada adicional de dedupe
                 * fornecida pelo FIFO.
                 *
                 * NÃO é nossa garantia principal
                 * de idempotência.
                 */
                MessageDeduplicationId:
                    event.messageId,
            }),
        );
    }

    private resolveMessageGroupId(
        event: IntegrationEventEnvelope<unknown>,
    ): string {
        const data =
            event.data;

        if (
            typeof data !== "object" ||
            data === null ||
            !("walletId" in data)
        ) {
            throw new Error(
                "Integration event requires walletId for SQS FIFO grouping",
            );
        }

        const walletId =
            data.walletId;

        if (
            typeof walletId !== "string" ||
            walletId.trim() === ""
        ) {
            throw new Error(
                "Integration event requires a valid walletId for SQS FIFO grouping",
            );
        }

        return walletId;
    }
}