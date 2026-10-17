import { createHash } from "node:crypto";

import type {
    EntityManager,
} from "@mikro-orm/postgresql";

import {
    ChangeMessageVisibilityCommand,
    DeleteMessageCommand,
    ReceiveMessageCommand,
    type SQSClient,
} from "@aws-sdk/client-sqs";

import {
    IdempotencyConflictError,
} from "../../application/services/accept-wager.service.js";

import {
    HandleWagerMessageService,
    InboxPayloadConflictError,
} from "../../application/services/handle-wager-message.service.js";

export interface WagerTransactionRequestedMessage {
    messageId: string;
    type: "WagerTransactionRequested";
    occurredAt: string;

    data: {
        providerId: string;
        externalTransactionId: string;
        idempotencyKey: string;

        playerId: string;
        walletId: string;

        roundId: string;
        gameId: string;

        kind: "BET" | "WIN" | "LOSS" | "REFUND" | "ROLLBACK";
        referenceExternalTransactionId?: string;

        money: {
            amount: string;
            currency: string;
        };
    };
}

export type ConsumeResult =
    | "EMPTY"
    | "ACKED"
    | "TRANSIENT_FAILURE"
    | "PERMANENT_FAILURE";

export class InvalidWagerMessageError extends Error {
    constructor(message: string) {
        super(message);
    }
}

export class WagerSqsConsumer {
    constructor(
        private readonly client: SQSClient,
        private readonly queueUrl: string,
        private readonly em: EntityManager,
        private readonly consumerName =
            "wager-transactions-consumer",
    ) {}

    async pollOnce():
        Promise<ConsumeResult> {

        const response =
            await this.client.send(
                new ReceiveMessageCommand({
                    QueueUrl:
                        this.queueUrl,

                    MaxNumberOfMessages:
                        1,

                    WaitTimeSeconds:
                        1,

                    MessageSystemAttributeNames: [
                        "ApproximateReceiveCount",
                    ],
                }),
            );

        const message =
            response.Messages?.[0];

        if (message === undefined) {
            return "EMPTY";
        }

        if (
            message.Body === undefined ||
            message.ReceiptHandle === undefined
        ) {
            return "PERMANENT_FAILURE";
        }

        try {
            const envelope =
                this.parseMessage(
                    message.Body,
                );

            /*
             * Este hash é da mensagem de transporte,
             * usado pela Inbox.
             *
             * É separado do payloadHash financeiro
             * calculado por AcceptWager.
             */
            const payloadHash =
                createHash("sha256")
                    .update(
                        message.Body,
                    )
                    .digest("hex");

            await new HandleWagerMessageService(
                this.em.fork(),
            ).execute({
                consumerName:
                    this.consumerName,

                messageId:
                    envelope.messageId,

                payloadHash,

                wager: {
                    kind: envelope.data.kind,
                    referenceExternalTransactionId: envelope.data.referenceExternalTransactionId,
                    providerId:
                        envelope.data.providerId,

                    externalTransactionId:
                        envelope.data
                            .externalTransactionId,

                    idempotencyKey:
                        envelope.data
                            .idempotencyKey,

                    playerId:
                        envelope.data.playerId,

                    walletId:
                        envelope.data.walletId,

                    roundId:
                        envelope.data.roundId,

                    gameId:
                        envelope.data.gameId,

                    money:
                        envelope.data.money,
                },
            });

            /*
             * HandleWagerMessageService.execute()
             * só retorna depois do COMMIT.
             *
             * Portanto o ACK acontece depois.
             */
            await this.client.send(
                new DeleteMessageCommand({
                    QueueUrl:
                        this.queueUrl,

                    ReceiptHandle:
                        message.ReceiptHandle,
                }),
            );

            return "ACKED";
        } catch (error) {
            if (
                this.isPermanentError(
                    error,
                )
            ) {
                /*
                 * Não fazemos ACK.
                 *
                 * A mensagem continuará sendo recebida
                 * até a redrive policy enviá-la à DLQ.
                 *
                 * Visibility = 0 acelera esse processo.
                 */
                await this.client.send(
                    new ChangeMessageVisibilityCommand({
                        QueueUrl:
                            this.queueUrl,

                        ReceiptHandle:
                            message.ReceiptHandle,

                        VisibilityTimeout:
                            0,
                    }),
                );

                return "PERMANENT_FAILURE";
            }

            const receiveCount =
                Number(
                    message.Attributes
                        ?.ApproximateReceiveCount ??
                    "1",
                );

            const backoffSeconds =
                Math.min(
                    2 ** Math.max(
                        receiveCount - 1,
                        0,
                    ),
                    30,
                );

            await this.client.send(
                new ChangeMessageVisibilityCommand({
                    QueueUrl:
                        this.queueUrl,

                    ReceiptHandle:
                        message.ReceiptHandle,

                    VisibilityTimeout:
                        backoffSeconds,
                }),
            );

            return "TRANSIENT_FAILURE";
        }
    }

    private isPermanentError(
        error: unknown,
    ): boolean {
        return (
            error instanceof
                InvalidWagerMessageError ||
            error instanceof
                InboxPayloadConflictError ||
            error instanceof
                IdempotencyConflictError
        );
    }

    private parseMessage(
        body: string,
    ): WagerTransactionRequestedMessage {
        let parsed: unknown;

        try {
            parsed =
                JSON.parse(
                    body,
                );
        } catch {
            throw new InvalidWagerMessageError(
                "SQS message body is not valid JSON",
            );
        }

        if (
            typeof parsed !== "object" ||
            parsed === null
        ) {
            throw new InvalidWagerMessageError(
                "SQS message must be an object",
            );
        }

        const envelope =
            parsed as Record<string, unknown>;

        if (
            typeof envelope.messageId !==
                "string" ||
            !envelope.messageId.trim()
        ) {
            throw new InvalidWagerMessageError(
                "SQS message requires messageId",
            );
        }

        if (
            envelope.type !==
            "WagerTransactionRequested"
        ) {
            throw new InvalidWagerMessageError(
                "Unsupported SQS message type",
            );
        }

        if (
            typeof envelope.occurredAt !==
                "string" ||
            Number.isNaN(
                Date.parse(
                    envelope.occurredAt,
                ),
            )
        ) {
            throw new InvalidWagerMessageError(
                "SQS message requires a valid occurredAt",
            );
        }

        if (
            typeof envelope.data !==
                "object" ||
            envelope.data === null
        ) {
            throw new InvalidWagerMessageError(
                "SQS message requires data",
            );
        }

        const data =
            envelope.data as
                Record<string, unknown>;

        const stringFields = [
            "providerId",
            "externalTransactionId",
            "idempotencyKey",
            "playerId",
            "walletId",
            "roundId",
            "gameId",
        ] as const;

        for (
            const field of stringFields
        ) {
            if (
                typeof data[field] !==
                    "string" ||
                !data[field].trim()
            ) {
                throw new InvalidWagerMessageError(
                    `Invalid ${field}`,
                );
            }
        }

        if (data.kind !== "BET" && data.kind !== "WIN" && data.kind !== "LOSS" && data.kind !== "REFUND" && data.kind !== "ROLLBACK") {
            throw new InvalidWagerMessageError(
                "Only BET/WIN/LOSS/REFUND/ROLLBACK are supported",
            );
        }

        if (((data.kind === "REFUND" || data.kind === "ROLLBACK") && data.referenceExternalTransactionId === undefined) ||
            (data.referenceExternalTransactionId !== undefined &&
                (typeof data.referenceExternalTransactionId !== "string" || !data.referenceExternalTransactionId.trim() || data.referenceExternalTransactionId.length > 255))) {
            throw new InvalidWagerMessageError("Invalid referenceExternalTransactionId");
        }

        if (
            typeof data.money !==
                "object" ||
            data.money === null
        ) {
            throw new InvalidWagerMessageError(
                "Invalid money",
            );
        }

        const money =
            data.money as
                Record<string, unknown>;

        if (
            typeof money.amount !==
                "string" ||
            typeof money.currency !==
                "string"
        ) {
            throw new InvalidWagerMessageError(
                "Invalid money",
            );
        }

        return parsed as
            WagerTransactionRequestedMessage;
    }
}