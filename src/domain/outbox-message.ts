import type {
    IntegrationEvent,
    IntegrationEventEnvelope,
} from "./events/integration-event.js";

export interface OutboxMessageState {
    id: string;
    eventType: string;
    eventVersion: number;
    payload: IntegrationEventEnvelope<unknown>;
    createdAt: Date;
    attempts: number;
    nextAttemptAt: Date;
    publishedAt?: Date;
}

export class OutboxMessage {
    private constructor(
        public readonly id: string,
        public readonly eventType: string,
        public readonly eventVersion: number,
        public readonly payload:
            IntegrationEventEnvelope<unknown>,
        private readonly _createdAt: Date,
        private _attempts: number,
        private _nextAttemptAt: Date,
        private _publishedAt?: Date,
    ) {}

    static fromEvent(
        event: IntegrationEvent<unknown>,
        createdAt: Date,
    ): OutboxMessage {
        return new OutboxMessage(
            event.messageId,
            event.type,
            event.version,
            event.toEnvelope(),
            new Date(createdAt.getTime()),
            0,
            new Date(createdAt.getTime()),
        );
    }

    static rehydrate(
        state: OutboxMessageState,
    ): OutboxMessage {
        if (state.attempts < 0) {
            throw new Error(
                "Outbox attempts cannot be negative",
            );
        }

        return new OutboxMessage(
            state.id,
            state.eventType,
            state.eventVersion,
            state.payload,
            new Date(state.createdAt.getTime()),
            state.attempts,
            new Date(
                state.nextAttemptAt.getTime(),
            ),
            state.publishedAt
                ? new Date(
                    state.publishedAt.getTime(),
                )
                : undefined,
        );
    }

    get createdAt(): Date {
        return new Date(
            this._createdAt.getTime(),
        );
    }

    get attempts(): number {
        return this._attempts;
    }

    get nextAttemptAt(): Date {
        return new Date(
            this._nextAttemptAt.getTime(),
        );
    }

    get publishedAt(): Date | undefined {
        return this._publishedAt
            ? new Date(
                this._publishedAt.getTime(),
            )
            : undefined;
    }

    isPublished(): boolean {
        return this._publishedAt !== undefined;
    }
}