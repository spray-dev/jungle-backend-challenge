import { describe, expect, it } from "bun:test";
import { InboxMessage } from "./inbox-message.js";

const HASH = "a".repeat(64);

describe("InboxMessage", () => {
    it("receives a new unprocessed message", () => {
        const receivedAt = new Date();

        const message = InboxMessage.receive({
            messageId: "msg-123",
            consumerName: "wager-transactions-consumer",
            payloadHash: HASH,
            receivedAt,
        });

        expect(message.messageId).toBe("msg-123");
        expect(message.consumerName)
            .toBe("wager-transactions-consumer");
        expect(message.payloadHash).toBe(HASH);
        expect(message.isProcessed()).toBe(false);
        expect(message.processedAt).toBeUndefined();
        expect(message.receivedAt).toEqual(receivedAt);
    });

    it("marks a message as processed", () => {
        const message = InboxMessage.receive({
            messageId: "msg-123",
            consumerName: "wager-transactions-consumer",
            payloadHash: HASH,
            receivedAt: new Date(),
        });

        const processedAt = new Date();

        message.markProcessed(processedAt);

        expect(message.isProcessed()).toBe(true);
        expect(message.processedAt).toEqual(processedAt);
    });

    it("does not allow a processed message to be processed again", () => {
        const message = InboxMessage.receive({
            messageId: "msg-123",
            consumerName: "wager-transactions-consumer",
            payloadHash: HASH,
            receivedAt: new Date(),
        });

        message.markProcessed(new Date());

        expect(() =>
            message.markProcessed(new Date()),
        ).toThrow("Inbox message is already processed");
    });

    it("rehydrates an already processed message", () => {
        const receivedAt = new Date("2026-10-16T12:00:00Z");
        const processedAt = new Date("2026-10-16T12:00:01Z");

        const message = InboxMessage.rehydrate({
            messageId: "msg-123",
            consumerName: "wager-transactions-consumer",
            payloadHash: HASH,
            receivedAt,
            processedAt,
        });

        expect(message.isProcessed()).toBe(true);
        expect(message.receivedAt).toEqual(receivedAt);
        expect(message.processedAt).toEqual(processedAt);
    });

    it("rejects an invalid payload hash", () => {
        expect(() =>
            InboxMessage.receive({
                messageId: "msg-123",
                consumerName: "wager-transactions-consumer",
                payloadHash: "not-a-sha256",
                receivedAt: new Date(),
            }),
        ).toThrow("Invalid inbox payload hash");
    });
});