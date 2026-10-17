import type {
    EntityManager,
} from "@mikro-orm/postgresql";

import type {
    IntegrationEventPublisher,
} from "../../domain/ports/integration-event-publisher.js";

import {
    MikroOrmOutboxMessageRepository,
} from "../../persistence/repositories/mikro-orm-outbox-message.repository.js";

export interface PublishOutboxResult {
    processed: number;
    published: number;
    failed: number;
}

type PublishAttemptResult =
    | "PUBLISHED"
    | "FAILED"
    | "EMPTY";

export class OutboxPublisherService {
    constructor(
        private readonly em: EntityManager,
        private readonly publisher:
            IntegrationEventPublisher,
        private readonly baseRetryMs = 1_000,
        private readonly maxRetryMs = 60_000,
    ) {
        if (
            !Number.isInteger(baseRetryMs) ||
            baseRetryMs < 1
        ) {
            throw new Error(
                "baseRetryMs must be a positive integer",
            );
        }

        if (
            !Number.isInteger(maxRetryMs) ||
            maxRetryMs < baseRetryMs
        ) {
            throw new Error(
                "maxRetryMs must be greater than or equal to baseRetryMs",
            );
        }
    }

    async publishPending(
        limit = 10,
    ): Promise<PublishOutboxResult> {
        if (this.em.isInTransaction()) {
            throw new Error(
                "OutboxPublisherService must own its transactions",
            );
        }

        if (
            !Number.isInteger(limit) ||
            limit < 1
        ) {
            throw new Error(
                "Outbox publish limit must be a positive integer",
            );
        }

        let processed = 0;
        let published = 0;
        let failed = 0;

        for (
            let index = 0;
            index < limit;
            index++
        ) {
            const result =
                await this.publishOne();

            if (result === "EMPTY") {
                break;
            }

            processed += 1;

            if (
                result === "PUBLISHED"
            ) {
                published += 1;
            } else {
                failed += 1;
            }
        }

        return {
            processed,
            published,
            failed,
        };
    }

    private async publishOne():
        Promise<PublishAttemptResult> {

        return this.em
            .fork()
            .transactional(
                async tx => {
                    const repository =
                        new MikroOrmOutboxMessageRepository(
                            tx,
                        );

                    const now =
                        new Date();

                    const [message] =
                        await repository.claimPending(
                            now,
                            1,
                        );

                    if (message === undefined) {
                        return "EMPTY";
                    }

                    try {
                        await this.publisher.publish(
                            message.payload,
                        );
                    } catch {
                        const retryAt =
                            new Date(
                                Date.now() +
                                this.retryDelay(
                                    message.attempts,
                                ),
                            );

                        message.scheduleRetry(
                            retryAt,
                        );

                        await repository.update(
                            message,
                        );

                        return "FAILED";
                    }

                    message.markPublished(
                        new Date(),
                    );

                    await repository.update(
                        message,
                    );

                    return "PUBLISHED";
                },
            );
    }

    private retryDelay(
        attempts: number,
    ): number {
        const exponential =
            this.baseRetryMs *
            (2 ** attempts);

        return Math.min(
            exponential,
            this.maxRetryMs,
        );
    }
}