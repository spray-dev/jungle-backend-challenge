import {
    EntitySchema,
} from "@mikro-orm/core";

import type {
    IntegrationEventEnvelope,
} from "../../domain/events/integration-event.js";

export interface OutboxMessageRow {
    id: string;

    eventType: string;
    eventVersion: number;

    payload:
        IntegrationEventEnvelope<unknown>;

    createdAt: Date;

    attempts: number;
    nextAttemptAt: Date;

    publishedAt?: Date;
}

export const OutboxMessageEntity =
    new EntitySchema<OutboxMessageRow>({
        name: "OutboxMessageEntity",
        tableName: "outbox_messages",

        properties: {
            id: {
                type: "uuid",
                primary: true,
            },

            eventType: {
                type: "string",
                fieldName: "event_type",
                length: 128,
            },

            eventVersion: {
                type: "integer",
                fieldName: "event_version",
            },

            payload: {
                type: "json",
            },

            createdAt: {
                type: "datetime",
                fieldName: "created_at",
            },

            attempts: {
                type: "integer",
            },

            nextAttemptAt: {
                type: "datetime",
                fieldName:
                    "next_attempt_at",
            },

            publishedAt: {
                type: "datetime",
                fieldName:
                    "published_at",
                nullable: true,
            },
        },
    });