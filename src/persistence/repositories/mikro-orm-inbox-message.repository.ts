import type { EntityManager } from "@mikro-orm/postgresql";

import { InboxMessage } from "../../domain/inbox-message.js";
import type { InboxMessageRepository } from "../../domain/ports/inbox-message.repository.js";
import { ConcurrencyConflictError } from "../../domain/ports/concurrency-conflict.error.js";

import {
    InboxMessageEntity,
    type InboxMessageRow,
} from "../entities/inbox-message.entity.js";

export class MikroOrmInboxMessageRepository
    implements InboxMessageRepository {

    constructor(
        private readonly em: EntityManager,
    ) {}

    async findByIdentity(
        consumerName: string,
        messageId: string,
    ): Promise<InboxMessage | null> {
        const row = await this.em.findOne(
            InboxMessageEntity,
            {
                consumerName,
                messageId,
            },
        );

        return row === null
            ? null
            : this.toDomain(row);
    }

    async tryInsert(
        message: InboxMessage,
    ): Promise<boolean> {
        const rows = await this.em
            .getConnection()
            .execute(
                `
                    insert into inbox_messages (
                        consumer_name,
                        message_id,
                        payload_hash,
                        received_at,
                        processed_at
                    )
                    values (?, ?, ?, ?, ?)
                    on conflict (
                        consumer_name,
                        message_id
                    )
                    do nothing
                    returning consumer_name
                `,
                [
                    message.consumerName,
                    message.messageId,
                    message.payloadHash,
                    message.receivedAt,
                    message.processedAt ?? null,
                ],
            );

        return rows.length === 1;
    }

    async markProcessed(
        message: InboxMessage,
    ): Promise<void> {
        const processedAt = message.processedAt;

        if (processedAt === undefined) {
            throw new Error(
                "Cannot persist unprocessed InboxMessage as processed",
            );
        }

        const rows = await this.em
            .getConnection()
            .execute(
                `
                    update inbox_messages
                    set processed_at = ?
                    where consumer_name = ?
                      and message_id = ?
                      and processed_at is null
                    returning consumer_name
                `,
                [
                    processedAt,
                    message.consumerName,
                    message.messageId,
                ],
            );

        if (rows.length !== 1) {
            throw new ConcurrencyConflictError(
                "Inbox message concurrency conflict",
            );
        }
    }

    private toDomain(
        row: InboxMessageRow,
    ): InboxMessage {
        return InboxMessage.rehydrate({
            consumerName: row.consumerName,
            messageId: row.messageId,
            payloadHash: row.payloadHash,
            receivedAt: row.receivedAt,
            processedAt: row.processedAt,
        });
    }
}