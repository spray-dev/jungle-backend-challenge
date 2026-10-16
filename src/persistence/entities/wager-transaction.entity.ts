import { EntitySchema } from "@mikro-orm/core";

export interface WagerTransactionRow {
    id: string;
    providerId: string;
    externalTransactionId: string;
    idempotencyKey: string;
    payloadHash: string;

    walletId: string;
    playerId: string;

    roundId: string;
    gameId: string;

    kind: string;
    status: string;

    amount: string;
    currency: string;

    referenceExternalTransactionId?: string;
    referenceTransactionId?: string;

    failureCode?: string;

    createdAt: Date;
    processedAt?: Date;
    observedBalance?: string;
    observedCurrency?: string;
}

export const WagerTransactionEntity =
    new EntitySchema<WagerTransactionRow>({
        name: "WagerTransactionEntity",
        tableName: "wager_transactions",

        properties: {
            observedBalance: { type: "decimal", precision: 18, scale: 2, fieldName: "observed_balance", nullable: true },
            observedCurrency: { type: "string", length: 3, fieldName: "observed_currency", nullable: true },
            id: {
                type: "uuid",
                primary: true,
            },

            providerId: {
                type: "string",
                fieldName: "provider_id",
            },

            externalTransactionId: {
                type: "string",
                fieldName: "external_transaction_id",
            },

            idempotencyKey: {
                type: "string",
                fieldName: "idempotency_key",
            },

            payloadHash: {
                type: "string",
                fieldName: "payload_hash",
            },

            walletId: {
                type: "uuid",
                fieldName: "wallet_id",
            },

            playerId: {
                type: "string",
                fieldName: "player_id",
            },

            roundId: {
                type: "string",
                fieldName: "round_id",
            },

            gameId: {
                type: "string",
                fieldName: "game_id",
            },

            kind: {
                type: "string",
                length: 16,
            },

            status: {
                type: "string",
                length: 32,
            },

            amount: {
                type: "decimal",
                precision: 18,
                scale: 2,
            },

            currency: {
                type: "string",
                length: 3,
            },

            referenceExternalTransactionId: {
                type: "string",
                fieldName: "reference_external_transaction_id",
                nullable: true,
            },

            referenceTransactionId: {
                type: "uuid",
                fieldName: "reference_transaction_id",
                nullable: true,
            },

            failureCode: {
                type: "string",
                fieldName: "failure_code",
                length: 64,
                nullable: true,
            },

            createdAt: {
                type: "datetime",
                fieldName: "created_at",
            },

            processedAt: {
                type: "datetime",
                fieldName: "processed_at",
                nullable: true,
            },
        },

        uniques: [
            {
                properties: [
                    "providerId",
                    "externalTransactionId",
                ],
            },
            {
                properties: [
                    "providerId",
                    "idempotencyKey",
                ],
            },
        ],
    });