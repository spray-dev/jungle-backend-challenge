export interface ReceiveInboxProps {
    messageId: string;
    consumerName: string;
    payloadHash: string;
    receivedAt: Date;
}

export interface InboxMessageState extends ReceiveInboxProps {
    processedAt?: Date;
}

export class InboxMessage {
    private readonly _receivedAt: Date;
    private _processedAt?: Date;

    private constructor(
        public readonly messageId: string,
        public readonly consumerName: string,
        public readonly payloadHash: string,
        receivedAt: Date,
        processedAt?: Date,
    ) {
        this._receivedAt = new Date(receivedAt.getTime());
        this._processedAt = processedAt
            ? new Date(processedAt.getTime())
            : undefined;
    }

    static receive(props: ReceiveInboxProps): InboxMessage {
        if (
            !props.messageId.trim() ||
            !props.consumerName.trim()
        ) {
            throw new Error("Inbox identity cannot be empty");
        }

        if (!/^[a-f0-9]{64}$/.test(props.payloadHash)) {
            throw new Error("Invalid inbox payload hash");
        }

        return new InboxMessage(
            props.messageId,
            props.consumerName,
            props.payloadHash,
            props.receivedAt,
        );
    }

    static rehydrate(state: InboxMessageState): InboxMessage {
        return new InboxMessage(
            state.messageId,
            state.consumerName,
            state.payloadHash,
            state.receivedAt,
            state.processedAt,
        );
    }

    get receivedAt(): Date {
        return new Date(this._receivedAt.getTime());
    }

    get processedAt(): Date | undefined {
        return this._processedAt
            ? new Date(this._processedAt.getTime())
            : undefined;
    }

    isProcessed(): boolean {
        return this._processedAt !== undefined;
    }

    markProcessed(at: Date): void {
        if (this.isProcessed()) {
            throw new Error("Inbox message is already processed");
        }

        this._processedAt = new Date(at.getTime());
    }
}