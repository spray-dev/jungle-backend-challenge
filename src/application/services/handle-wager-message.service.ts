import { EntityManager } from "@mikro-orm/postgresql";

import { InboxMessage } from "../../domain/inbox-message.js";
import { ConcurrencyConflictError } from "../../domain/ports/concurrency-conflict.error.js";

import {
    WagerTransactionStatus,
    type WagerTransaction,
} from "../../domain/wager-transaction.js";

import { MikroOrmInboxMessageRepository } from "../../persistence/repositories/mikro-orm-inbox-message.repository.js";

import {
    acceptBetInTransaction,
    type AcceptBetCommand,
} from "./accept-bet.service.js";

import {
    processBetInTransaction,
} from "./process-bet.service.js";

import {
    OutboxMessage,
} from "../../domain/outbox-message.js";

import {
    WagerTransactionProcessedEvent,
} from "../../domain/events/wager-transaction-processed.event.js";

import {
    WagerTransactionRejectedEvent,
} from "../../domain/events/wager-transaction-rejected.event.js";

import {
    MikroOrmOutboxMessageRepository,
} from "../../persistence/repositories/mikro-orm-outbox-message.repository.js";

export interface HandleWagerMessageCommand {
    consumerName: string;
    messageId: string;

    /*
     * SHA-256 do payload da mensagem.
     *
     * Quando ligarmos SQS, o adapter de transporte
     * será responsável por calcular esse hash.
     */
    payloadHash: string;

    wager: AcceptBetCommand;
}

export interface HandleWagerMessageResult {
    transaction: WagerTransaction;

    /*
     * true = esta identidade da Inbox
     * já tinha sido recebida.
     */
    duplicateMessage: boolean;

    /*
     * true = a operação financeira já existia
     * pela idempotência do provider.
     */
    idempotentReplay: boolean;
}

export class InboxPayloadConflictError extends Error {
    readonly code = "INBOX_PAYLOAD_CONFLICT";

    constructor() {
        super(
            "Inbox message identity was reused with a different payload",
        );
    }
}

export class HandleWagerMessageService {
    constructor(
        private readonly em: EntityManager,
        private readonly maxAttempts = 5,
    ) {
        if (
            !Number.isInteger(maxAttempts) ||
            maxAttempts < 1
        ) {
            throw new Error(
                "maxAttempts must be a positive integer",
            );
        }
    }

    async execute(
        command: HandleWagerMessageCommand,
    ): Promise<HandleWagerMessageResult> {
        if (this.em.isInTransaction()) {
            throw new Error(
                "HandleWagerMessageService must own its transaction",
            );
        }

        for (
            let attempt = 1;
            ;
            attempt++
        ) {
            try {
                return await this.em
                    .fork()
                    .transactional(
                        async tx =>
                            this.executeInTransaction(
                                tx,
                                command,
                            ),
                        {
                            clear: true,
                        },
                    );
            } catch (error) {
                if (
                    !(
                        error instanceof
                        ConcurrencyConflictError
                    ) ||
                    attempt >= this.maxAttempts
                ) {
                    throw error;
                }
            }
        }
    }

    private async executeInTransaction(
        tx: EntityManager,
        command: HandleWagerMessageCommand,
    ): Promise<HandleWagerMessageResult> {
        const inboxRepository =
            new MikroOrmInboxMessageRepository(
                tx,
            );

        let inbox =
            InboxMessage.receive({
                consumerName:
                    command.consumerName,

                messageId:
                    command.messageId,

                payloadHash:
                    command.payloadHash,

                receivedAt:
                    new Date(),
            });

        const inserted =
            await inboxRepository.tryInsert(
                inbox,
            );

        const duplicateMessage =
            !inserted;

        /*
         * Se não inserimos, a PK
         * (consumerName, messageId)
         * já existia.
         */
        if (!inserted) {
            const existing =
                await inboxRepository.findByIdentity(
                    command.consumerName,
                    command.messageId,
                );

            if (existing === null) {
                throw new Error(
                    "Inbox conflict detected but persisted message was not found",
                );
            }

            /*
             * Mesmo messageId com conteúdo diferente
             * não pode ser tratado como replay válido.
             */
            if (
                existing.payloadHash !==
                command.payloadHash
            ) {
                throw new InboxPayloadConflictError();
            }

            inbox = existing;

            /*
             * Se já foi completamente processada,
             * podemos reconstruir o resultado
             * pelas garantias idempotentes da wager.
             */
            if (inbox.isProcessed()) {
                const accepted =
                    await acceptBetInTransaction(
                        tx,
                        command.wager,
                    );

                const transaction =
                    await processBetInTransaction(
                        tx,
                        accepted.transaction.id,
                    );

                return {
                    transaction,
                    duplicateMessage: true,
                    idempotentReplay:
                        accepted.idempotentReplay,
                };
            }
        }

        /*
         * Daqui para baixo tudo acontece na
         * MESMA transaction da Inbox.
         */
        const accepted =
            await acceptBetInTransaction(
                tx,
                command.wager,
            );

        const transaction =
            await processBetInTransaction(
                tx,
                accepted.transaction.id,
            );

        const occurredAt =
            new Date();

        const event =
            transaction.status ===
                WagerTransactionStatus.Processed
                ? new WagerTransactionProcessedEvent(
                    crypto.randomUUID(),
                    occurredAt,
                    transaction,
                )
                : transaction.status ===
                    WagerTransactionStatus.Rejected
                    ? new WagerTransactionRejectedEvent(
                        crypto.randomUUID(),
                        occurredAt,
                        transaction,
                    )
                    : null;

        if (event !== null) {
            const outboxRepository =
                new MikroOrmOutboxMessageRepository(
                    tx,
                );

            const outboxMessage =
                OutboxMessage.fromEvent(
                    event,
                    occurredAt,
                );

            await outboxRepository.insert(
                outboxMessage,
            );
        }

        inbox.markProcessed(
            new Date(),
        );

        await inboxRepository.markProcessed(
            inbox,
        );

        return {
            transaction,
            duplicateMessage,
            idempotentReplay:
                accepted.idempotentReplay,
        };
    }
}