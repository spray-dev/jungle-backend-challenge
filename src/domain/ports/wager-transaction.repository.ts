import {
    WagerTransaction,
    WagerTransactionStatus,
} from "../wager-transaction.js";

export interface WagerTransactionRepository {
    findById(id: string): Promise<WagerTransaction | null>;

    findByProviderAndExternalTransactionId(
        providerId: string,
        externalTransactionId: string,
    ): Promise<WagerTransaction | null>;

    findByProviderAndIdempotencyKey(
        providerId: string,
        idempotencyKey: string,
    ): Promise<WagerTransaction | null>;

    insert(transaction: WagerTransaction): Promise<void>;

    update(
        transaction: WagerTransaction,
        expectedStatus: WagerTransactionStatus,
    ): Promise<void>;
}