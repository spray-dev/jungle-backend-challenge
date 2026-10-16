import { EntityManager } from "@mikro-orm/postgresql";

import { Money } from "../../domain/money.js";

import {
    FailureCode,
    WagerTransaction,
    WagerTransactionKind,
    WagerTransactionStatus,
} from "../../domain/wager-transaction.js";

import type { WagerTransactionRepository } from "../../domain/ports/wager-transaction.repository.js";
import { ConcurrencyConflictError } from "../../domain/ports/concurrency-conflict.error.js";

import {
    WagerTransactionEntity,
    type WagerTransactionRow,
} from "../entities/wager-transaction.entity.js";

export class MikroOrmWagerTransactionRepository
    implements WagerTransactionRepository {
    constructor(private readonly em: EntityManager) { }

    async findById(
        id: string,
    ): Promise<WagerTransaction | null> {
        const row = await this.em.findOne(
            WagerTransactionEntity,
            { id },
        );

        return row === null
            ? null
            : this.toDomain(row);
    }

    async findByProviderAndExternalTransactionId(
        providerId: string,
        externalTransactionId: string,
    ): Promise<WagerTransaction | null> {
        const row = await this.em.findOne(
            WagerTransactionEntity,
            {
                providerId,
                externalTransactionId,
            },
        );

        return row === null
            ? null
            : this.toDomain(row);
    }

    async findByProviderAndIdempotencyKey(
        providerId: string,
        idempotencyKey: string,
    ): Promise<WagerTransaction | null> {
        const row = await this.em.findOne(
            WagerTransactionEntity,
            {
                providerId,
                idempotencyKey,
            },
        );

        return row === null
            ? null
            : this.toDomain(row);
    }

    async insert(
        transaction: WagerTransaction,
    ): Promise<void> {
        await this.em.insert(
            WagerTransactionEntity,
            this.toRow(transaction),
        );
    }

    async tryInsert(
        transaction: WagerTransaction,
    ): Promise<boolean> {
        const row = this.toRow(transaction);

        const rows = await this.em.execute<any[]>(
            `
        insert into wager_transactions (
            id,
            provider_id,
            external_transaction_id,
            idempotency_key,
            payload_hash,
            wallet_id,
            player_id,
            round_id,
            game_id,
            kind,
            status,
            amount,
            currency,
            reference_external_transaction_id,
            reference_transaction_id,
            failure_code,
            created_at,
            processed_at,
            observed_balance,
            observed_currency
        )
        values (
            ?, ?, ?, ?, ?,
            ?, ?, ?, ?, ?,
            ?, ?, ?, ?, ?,
            ?, ?, ?, ?, ?
        )
        on conflict do nothing
        returning id
    `,
            [
                row.id,
                row.providerId,
                row.externalTransactionId,
                row.idempotencyKey,
                row.payloadHash,

                row.walletId,
                row.playerId,
                row.roundId,
                row.gameId,

                row.kind,
                row.status,

                row.amount,
                row.currency,

                row.referenceExternalTransactionId ?? null,
                row.referenceTransactionId ?? null,

                row.failureCode ?? null,

                row.createdAt,
                row.processedAt ?? null,

                row.observedBalance ?? null,
                row.observedCurrency ?? null,
            ],
        );

        return rows.length === 1;
    }

    async update(
        transaction: WagerTransaction,
        expectedStatus: WagerTransactionStatus,
    ): Promise<void> {
        const row = this.toRow(transaction);

        const affectedRows = await this.em.nativeUpdate(
            WagerTransactionEntity,
            {
                id: row.id,
                status: expectedStatus,
            },
            {
                status: row.status,
                ...(row.observedBalance !== undefined ? { observedBalance: row.observedBalance, observedCurrency: row.observedCurrency } : {}),

                ...(row.referenceTransactionId !== undefined
                    ? {
                        referenceTransactionId:
                            row.referenceTransactionId,
                    }
                    : {}),

                ...(row.failureCode !== undefined
                    ? {
                        failureCode: row.failureCode,
                    }
                    : {}),

                ...(row.processedAt !== undefined
                    ? {
                        processedAt: row.processedAt,
                    }
                    : {}),
            },
        );

        if (affectedRows !== 1) {
            throw new ConcurrencyConflictError(
                "Wager transaction concurrency conflict",
            );
        }
    }

    private toDomain(
        row: WagerTransactionRow,
    ): WagerTransaction {
        return WagerTransaction.rehydrate({
            id: row.id,
            providerId: row.providerId,
            externalTransactionId:
                row.externalTransactionId,
            idempotencyKey: row.idempotencyKey,
            payloadHash: row.payloadHash,

            walletId: row.walletId,
            playerId: row.playerId,

            roundId: row.roundId,
            gameId: row.gameId,

            kind: row.kind as WagerTransactionKind,

            money: Money.from({
                amount: row.amount,
                currency: row.currency,
            }),

            referenceExternalTransactionId:
                row.referenceExternalTransactionId,

            createdAt: row.createdAt,

            status:
                row.status as WagerTransactionStatus,

            referenceTransactionId:
                row.referenceTransactionId,

            failureCode:
                row.failureCode as FailureCode | undefined,

            processedAt: row.processedAt,
            observedBalance: row.observedBalance != null && row.observedCurrency != null
                ? Money.from({ amount: row.observedBalance, currency: row.observedCurrency }) : undefined,
        });
    }

    private toRow(
        transaction: WagerTransaction,
    ): WagerTransactionRow {
        return {
            id: transaction.id,
            providerId: transaction.providerId,
            externalTransactionId:
                transaction.externalTransactionId,
            idempotencyKey: transaction.idempotencyKey,
            payloadHash: transaction.payloadHash,

            walletId: transaction.walletId,
            playerId: transaction.playerId,

            roundId: transaction.roundId,
            gameId: transaction.gameId,

            kind: transaction.kind,
            status: transaction.status,

            amount: transaction.money.toJSON().amount,
            currency: transaction.money.toJSON().currency,

            referenceExternalTransactionId:
                transaction.referenceExternalTransactionId,

            referenceTransactionId:
                transaction.referenceTransactionId,

            failureCode: transaction.failureCode,

            createdAt: transaction.createdAt,
            processedAt: transaction.processedAt,
            observedBalance: transaction.observedBalance?.toJSON().amount,
            observedCurrency: transaction.observedBalance?.currency,
        };
    }
}
