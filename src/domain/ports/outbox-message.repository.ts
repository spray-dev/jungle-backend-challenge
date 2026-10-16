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
}