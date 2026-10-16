import type {
    EntityManager,
} from "@mikro-orm/postgresql";

import {
    OutboxMessage,
} from "../../domain/outbox-message.js";

import type {
    OutboxMessageRepository,
} from "../../domain/ports/outbox-message.repository.js";

import {
    OutboxMessageEntity,
    type OutboxMessageRow,
} from "../entities/outbox-message.entity.js";

export class MikroOrmOutboxMessageRepository
    implements OutboxMessageRepository {

    constructor(
        private readonly em:
            EntityManager,
    ) {}

    async insert(
        message: OutboxMessage,
    ): Promise<void> {
        await this.em.execute(
            `
                insert into outbox_messages (
                    id,
                    event_type,
                    event_version,
                    payload,
                    created_at,
                    attempts,
                    next_attempt_at,
                    published_at
                )
                values (
                    ?, ?, ?, ?::jsonb,
                    ?, ?, ?, ?
                )
            `,
            [
                message.id,
                message.eventType,
                message.eventVersion,

                JSON.stringify(
                    message.payload,
                ),

                message.createdAt,
                message.attempts,
                message.nextAttemptAt,
                message.publishedAt ?? null,
            ],
        );
    }

    async findById(
        id: string,
    ): Promise<OutboxMessage | null> {
        const row =
            await this.em.findOne(
                OutboxMessageEntity,
                {
                    id,
                },
            );

        return row === null
            ? null
            : this.toDomain(row);
    }

    private toDomain(
        row: OutboxMessageRow,
    ): OutboxMessage {
        return OutboxMessage.rehydrate({
            id: row.id,

            eventType:
                row.eventType,

            eventVersion:
                row.eventVersion,

            payload:
                row.payload,

            createdAt:
                row.createdAt,

            attempts:
                row.attempts,

            nextAttemptAt:
                row.nextAttemptAt,

            publishedAt:
                row.publishedAt,
        });
    }
}