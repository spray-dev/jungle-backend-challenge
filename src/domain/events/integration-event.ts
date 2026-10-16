export interface IntegrationEventEnvelope<TData> {
    messageId: string;
    type: string;
    version: number;
    occurredAt: string;
    data: TData;
}

export abstract class IntegrationEvent<TData> {
    abstract readonly type: string;
    abstract readonly version: number;

    protected constructor(
        public readonly messageId: string,
        private readonly _occurredAt: Date,
    ) {}

    abstract get data(): TData;

    get occurredAt(): Date {
        return new Date(
            this._occurredAt.getTime(),
        );
    }

    toEnvelope():
        IntegrationEventEnvelope<TData> {
        return {
            messageId: this.messageId,
            type: this.type,
            version: this.version,
            occurredAt:
                this._occurredAt.toISOString(),
            data: this.data,
        };
    }
}