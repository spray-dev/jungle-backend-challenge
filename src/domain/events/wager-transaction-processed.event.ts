import {
    IntegrationEvent,
} from "./integration-event.js";

import type {
    MoneyProps,
} from "../money.js";

import {
    WagerTransaction,
    WagerTransactionStatus,
} from "../wager-transaction.js";

export interface WagerTransactionProcessedData {
    transactionId: string;

    providerId: string;
    externalTransactionId: string;
    idempotencyKey: string;

    walletId: string;
    playerId: string;

    roundId: string;
    gameId: string;

    kind: string;

    money: MoneyProps;

    balance?: MoneyProps;
}

export class WagerTransactionProcessedEvent
    extends IntegrationEvent<WagerTransactionProcessedData> {

    readonly type =
        "WagerTransactionProcessed";

    readonly version = 1;

    constructor(
        messageId: string,
        occurredAt: Date,
        private readonly transaction:
            WagerTransaction,
    ) {
        super(
            messageId,
            occurredAt,
        );

        if (
            transaction.status !==
            WagerTransactionStatus.Processed
        ) {
            throw new Error(
                "WagerTransactionProcessedEvent requires a processed transaction",
            );
        }
    }

    get data():
        WagerTransactionProcessedData {
        return {
            transactionId:
                this.transaction.id,

            providerId:
                this.transaction.providerId,

            externalTransactionId:
                this.transaction
                    .externalTransactionId,

            idempotencyKey:
                this.transaction.idempotencyKey,

            walletId:
                this.transaction.walletId,

            playerId:
                this.transaction.playerId,

            roundId:
                this.transaction.roundId,

            gameId:
                this.transaction.gameId,

            kind:
                this.transaction.kind,

            money:
                this.transaction.money.toJSON(),

            balance:
                this.transaction
                    .observedBalance
                    ?.toJSON(),
        };
    }
}