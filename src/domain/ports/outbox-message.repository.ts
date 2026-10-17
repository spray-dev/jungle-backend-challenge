import type {
    OutboxMessage,
} from "../outbox-message.js";

export interface OutboxMessageRepository {
    insert(
        message: OutboxMessage,
    ): Promise<void>;

    findById(
        id: string,
    ): Promise<OutboxMessage | null>;

    claimPending(
        now: Date,
        limit: number,
    ): Promise<OutboxMessage[]>;

    update(
        message: OutboxMessage,
    ): Promise<void>;
}