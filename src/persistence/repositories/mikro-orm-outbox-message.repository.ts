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

    async claimPending(
    now: Date,
    limit: number,
): Promise<OutboxMessage[]> {
    if (!this.em.isInTransaction()) {
        throw new Error(
            "claimPending requires an active transaction",
        );
    }

    if (
        !Number.isInteger(limit) ||
        limit < 1
    ) {
        throw new Error(
            "Outbox claim limit must be a positive integer",
        );
    }

    const rows =
        await this.em.execute<any[]>(
            `
                select
                    id,
                    event_type,
                    event_version,
                    payload,
                    created_at,
                    attempts,
                    next_attempt_at,
                    published_at
                from outbox_messages
                where published_at is null
                  and next_attempt_at <= ?
                order by
                    next_attempt_at asc,
                    created_at asc
                for update skip locked
                limit ?
            `,
            [
                now,
                limit,
            ],
        );

    return rows.map(
        row =>
            OutboxMessage.rehydrate({
                id:
                    row.id,

                eventType:
                    row.event_type,

                eventVersion:
                    row.event_version,

                payload:
                    row.payload,

                createdAt:
                    new Date(
                        row.created_at,
                    ),

                attempts:
                    row.attempts,

                nextAttemptAt:
                    new Date(
                        row.next_attempt_at,
                    ),

                publishedAt:
                    row.published_at
                        ? new Date(
                            row.published_at,
                        )
                        : undefined,
            }),
    );
    }

    async update(
        message: OutboxMessage,
    ): Promise<void> {
        const rows =
            await this.em.execute<any[]>(
                `
                update outbox_messages
                set
                    attempts = ?,
                    next_attempt_at = ?,
                    published_at = ?
                where id = ?
                returning id
            `,
                [
                    message.attempts,
                    message.nextAttemptAt,
                    message.publishedAt ?? null,
                    message.id,
                ],
            );

        if (rows.length !== 1) {
            throw new Error(
                `Outbox message ${message.id} was not found`,
            );
        }
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