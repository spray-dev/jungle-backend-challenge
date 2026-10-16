import { EntityManager } from "@mikro-orm/postgresql";

import { Money } from "../../domain/money.js";
import { Wallet } from "../../domain/wallet.js";
import type { WalletRepository } from "../../domain/ports/wallet.repository.js";
import { ConcurrencyConflictError } from "../../domain/ports/concurrency-conflict.error.js";

import {
    WalletEntity,
    type WalletRow,
} from "../entities/wallet.entity.js";

export class MikroOrmWalletRepository implements WalletRepository {
    constructor(private readonly em: EntityManager) { }

    async findById(id: string): Promise<Wallet | null> {
        const row = await this.em.findOne(WalletEntity, { id });

        if (row === null) {
            return null;
        }

        return this.toDomain(row);
    }

    async findByPlayerIdAndCurrency(
        playerId: string,
        currency: string,
    ): Promise<Wallet | null> {
        const row = await this.em.findOne(WalletEntity, {
            playerId,
            currency,
        });

        if (row === null) {
            return null;
        }

        return this.toDomain(row);
    }

    async create(wallet: Wallet): Promise<void> {
        const row = this.toRow(wallet);

        await this.em.insert(WalletEntity, row);
    }

    async update(
        wallet: Wallet,
        expectedVersion: number,
    ): Promise<void> {
        const row = this.toRow(wallet);

        const affectedRows = await this.em.nativeUpdate(
            WalletEntity,
            {
                id: row.id,
                version: expectedVersion,
            },
            {
                balance: row.balance,
                version: row.version,
                updatedAt: row.updatedAt,
            },
        );

        if (affectedRows !== 1) {
            throw new ConcurrencyConflictError("Wallet concurrency conflict");
        }
    }

    private toDomain(row: WalletRow): Wallet {
        return Wallet.rehydrate({
            id: row.id,
            playerId: row.playerId,
            currency: row.currency,
            balance: Money.from({
                amount: row.balance,
                currency: row.currency,
            }),
            version: row.version,
            createdAt: row.createdAt,
            updatedAt: row.updatedAt,
        });
    }

    private toRow(wallet: Wallet): WalletRow {
        return {
            id: wallet.id,
            playerId: wallet.playerId,
            currency: wallet.currency,
            balance: wallet.balance.toJSON().amount,
            version: wallet.version,
            createdAt: wallet.createdAt,
            updatedAt: wallet.updatedAt,
        };
    }
}
