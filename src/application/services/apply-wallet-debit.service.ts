import { EntityManager } from "@mikro-orm/postgresql";

import { Money } from "../../domain/money.js";
import { WalletLedgerEntry } from "../../domain/wallet-ledger-entry.js";

import { MikroOrmWalletRepository } from "../../persistence/repositories/mikro-orm-wallet.repository.js";
import { MikroOrmWalletLedgerRepository } from "../../persistence/repositories/mikro-orm-wallet-ledger.repository.js";

export interface ApplyWalletDebitInput {
    walletId: string;
    transactionId: string;
    amount: string;
}

export class ApplyWalletDebitService {
    constructor(private readonly em: EntityManager) { }

    async execute(input: ApplyWalletDebitInput): Promise<void> {
        await this.em.transactional(
            async (tx) => {
                const walletRepository =
                    new MikroOrmWalletRepository(tx);

                const ledgerRepository =
                    new MikroOrmWalletLedgerRepository(tx);

                const wallet =
                    await walletRepository.findById(input.walletId);

                if (wallet === null) {
                    throw new Error("Wallet not found");
                }

                const expectedVersion = wallet.version;

                const amount = Money.from({
                    amount: input.amount,
                    currency: wallet.currency,
                });

                const movement = wallet.debit(amount);

                if (movement === null) {
                    return;
                }

                await walletRepository.update(
                    wallet,
                    expectedVersion,
                );

                const ledgerEntry =
                    WalletLedgerEntry.create({
                        id: crypto.randomUUID(),
                        walletId: wallet.id,
                        transactionId: input.transactionId,
                        direction: "DEBIT",
                        amount,
                        balanceBefore: movement.balanceBefore,
                        balanceAfter: movement.balanceAfter,
                        createdAt: new Date(),
                    });

                await ledgerRepository.insert(ledgerEntry);
            },
            {
                clear: true,
            },
        );
    }
}