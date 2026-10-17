import { EntityManager } from "@mikro-orm/postgresql";

import { InboxMessage } from "../../domain/inbox-message.js";
import { ConcurrencyConflictError } from "../../domain/ports/concurrency-conflict.error.js";

import {
    WagerTransactionStatus,
    type WagerTransaction,
} from "../../domain/wager-transaction.js";

import { MikroOrmInboxMessageRepository } from "../../persistence/repositories/mikro-orm-inbox-message.repository.js";

import {
    acceptWagerInTransaction,
    type AcceptWagerCommand,
} from "./accept-wager.service.js";

import {
    processWagerInTransaction,
} from "./process-wager.service.js";

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

export async function handleWagerMessageInTransaction(
    tx: EntityManager,
    command: HandleWagerMessageCommand,
): Promise<HandleWagerMessageResult> {
    if (!tx.isInTransaction()) {
        throw new Error(
            "handleWagerMessageInTransaction requires an active transaction",
        );
    }

    const inboxRepository =
        new MikroOrmInboxMessageRepository(tx);

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

        if (
            existing.payloadHash !==
            command.payloadHash
        ) {
            throw new InboxPayloadConflictError();
        }

        inbox = existing;

        if (inbox.isProcessed()) {
            const accepted =
                await acceptWagerInTransaction(
                    tx,
                    { ...command.wager, kind: command.wager.kind ?? "BET" },
                );

            const transaction =
                await processWagerInTransaction(
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

    const accepted =
        await acceptWagerInTransaction(
            tx,
            { ...command.wager, kind: command.wager.kind ?? "BET" },
        );

    const wasTerminalBeforeProcessing =
        accepted.transaction.isTerminal();

    const transaction =
        await processWagerInTransaction(
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

    if (
        event !== null &&
        !wasTerminalBeforeProcessing
    ) {
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

    // Missing kind remains BET for existing in-process callers; SQS requires it.
    wager: Omit<AcceptWagerCommand, "kind"> & { kind?: AcceptWagerCommand["kind"] };
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
                            handleWagerMessageInTransaction(
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
}