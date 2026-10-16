import type { InboxMessage } from "../inbox-message.js";

export interface InboxMessageRepository {
    findByIdentity(
        consumerName: string,
        messageId: string,
    ): Promise<InboxMessage | null>;

    tryInsert(
        message: InboxMessage,
    ): Promise<boolean>;

    markProcessed(
        message: InboxMessage,
    ): Promise<void>;
}