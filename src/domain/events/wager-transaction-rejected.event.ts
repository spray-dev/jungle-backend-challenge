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

export interface WagerTransactionRejectedData {
    transactionId: string;

    providerId: string;
    externalTransactionId: string;

    walletId: string;
    playerId: string;

    roundId: string;
    gameId: string;

    kind: string;

    money: MoneyProps;

    balance?: MoneyProps;

    failureCode: string;
}

export class WagerTransactionRejectedEvent
    extends IntegrationEvent<WagerTransactionRejectedData> {

    readonly type =
        "WagerTransactionRejected";

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
            WagerTransactionStatus.Rejected
        ) {
            throw new Error(
                "WagerTransactionRejectedEvent requires a rejected transaction",
            );
        }

        if (
            transaction.failureCode ===
            undefined
        ) {
            throw new Error(
                "Rejected transaction requires a failure code",
            );
        }
    }

    get data():
        WagerTransactionRejectedData {

        const failureCode =
            this.transaction.failureCode;

        if (failureCode === undefined) {
            throw new Error(
                "Rejected transaction requires a failure code",
            );
        }

        return {
            transactionId:
                this.transaction.id,

            providerId:
                this.transaction.providerId,

            externalTransactionId:
                this.transaction
                    .externalTransactionId,

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

            failureCode,
        };
    }
}