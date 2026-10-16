import { EntityManager } from "@mikro-orm/postgresql";

import { WalletLedgerEntry } from "../../domain/wallet-ledger-entry.js";
import type { WalletLedgerRepository } from "../../domain/ports/wallet-ledger.repository.js";

import {
  WalletLedgerEntryEntity,
  type WalletLedgerEntryRow,
} from "../entities/wallet-ledger-entry.entity.js";

export class MikroOrmWalletLedgerRepository
  implements WalletLedgerRepository
{
  constructor(private readonly em: EntityManager) {}

  async insert(entry: WalletLedgerEntry): Promise<void> {
    const row = this.toRow(entry);

    await this.em.insert(
      WalletLedgerEntryEntity,
      row,
    );
  }

  private toRow(
    entry: WalletLedgerEntry,
  ): WalletLedgerEntryRow {
    return {
      id: entry.id,
      walletId: entry.walletId,
      transactionId: entry.transactionId,
      direction: entry.direction,

      amount: entry.amount.toJSON().amount,

      balanceBefore:
        entry.balanceBefore.toJSON().amount,

      balanceAfter:
        entry.balanceAfter.toJSON().amount,

      createdAt: entry.createdAt,
    };
  }
}