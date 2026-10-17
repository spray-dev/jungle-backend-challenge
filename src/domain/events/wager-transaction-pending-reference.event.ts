import { IntegrationEvent } from "./integration-event.js";
import { WagerTransaction, WagerTransactionStatus } from "../wager-transaction.js";

export class WagerTransactionPendingReferenceEvent extends IntegrationEvent<{
    transactionId: string; providerId: string; externalTransactionId: string;
    walletId: string; kind: string; referenceExternalTransactionId: string;
}> {
    readonly type = "WagerTransactionPendingReference";
    readonly version = 1;
    constructor(messageId: string, occurredAt: Date, private readonly transaction: WagerTransaction) {
        super(messageId, occurredAt);
        if (transaction.status !== WagerTransactionStatus.PendingReference || !transaction.referenceExternalTransactionId) {
            throw new Error("Pending reference event requires a pending reference transaction");
        }
    }
    get data() {
        return { transactionId: this.transaction.id, providerId: this.transaction.providerId,
            externalTransactionId: this.transaction.externalTransactionId, walletId: this.transaction.walletId,
            kind: this.transaction.kind, referenceExternalTransactionId: this.transaction.referenceExternalTransactionId! };
    }
}
