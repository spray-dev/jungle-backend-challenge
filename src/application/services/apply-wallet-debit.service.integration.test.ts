import {
    afterAll,
    beforeAll,
    describe,
    expect,
    it,
} from "bun:test";

import { MikroORM } from "@mikro-orm/postgresql";

import { createTestOrm, closeTestOrm } from "../../testing/integration-database.js";
import { Money } from "../../domain/money.js";
import { Wallet } from "../../domain/wallet.js";

import { MikroOrmWalletRepository } from "../../persistence/repositories/mikro-orm-wallet.repository.js";
import { ApplyWalletDebitService } from "./apply-wallet-debit.service.js";
import { createWagerFixture } from "../../testing/create-wager-fixture.js";

let orm: MikroORM;


beforeAll(async () => {
    orm = await createTestOrm();
}, 30000);


afterAll(async () => {
    await closeTestOrm(orm);
});

describe("ApplyWalletDebitService integration", () => {
    it("rolls back the wallet update when ledger insert fails", async () => {
        const walletId = crypto.randomUUID();


        const now = new Date();

        const wallet = Wallet.rehydrate({
            id: walletId,
            playerId: `player-${walletId}`,
            currency: "BRL",
            balance: Money.from({
                amount: "100.00",
                currency: "BRL",
            }),
            version: 1,
            createdAt: now,
            updatedAt: now,
        });

        const setupRepository =
            new MikroOrmWalletRepository(orm.em.fork());

        await setupRepository.create(wallet);

        const service = new ApplyWalletDebitService(
            orm.em.fork(),
        );

        await expect(
            service.execute({
                walletId,
                transactionId: "not-a-valid-uuid",
                amount: "20.00",
            }),
        ).rejects.toThrow();

        const verificationRepository =
            new MikroOrmWalletRepository(orm.em.fork());

        const persisted =
            await verificationRepository.findById(walletId);

        expect(persisted).not.toBeNull();

        expect(
            persisted?.balance.equals(
                Money.from({
                    amount: "100.00",
                    currency: "BRL",
                }),
            ),
        ).toBe(true);

        expect(persisted?.version).toBe(1);

        const ledgerRows =
            await orm.em.getConnection().execute(
                `
          select *
          from wallet_ledger_entries
          where wallet_id = ?
        `,
                [walletId],
            );

        expect(ledgerRows).toHaveLength(0);
    });

    it("commits both wallet update and ledger entry", async () => {
        const walletId = crypto.randomUUID();
        const transactionId = crypto.randomUUID();


        const now = new Date();

        const wallet = Wallet.rehydrate({
            id: walletId,
            playerId: `player-${walletId}`,
            currency: "BRL",
            balance: Money.from({
                amount: "100.00",
                currency: "BRL",
            }),
            version: 1,
            createdAt: now,
            updatedAt: now,
        });

        const setupRepository =
            new MikroOrmWalletRepository(orm.em.fork());

        await setupRepository.create(wallet);

        const service = new ApplyWalletDebitService(
            orm.em.fork(),
        );

        await createWagerFixture(orm.em.fork(), walletId, transactionId);

        await service.execute({
            walletId,
            transactionId,
            amount: "20.00",
        });

        // Verifica a Wallet depois do COMMIT.
        const verificationRepository =
            new MikroOrmWalletRepository(orm.em.fork());

        const persisted =
            await verificationRepository.findById(walletId);

        expect(persisted).not.toBeNull();

        expect(
            persisted?.balance.equals(
                Money.from({
                    amount: "80.00",
                    currency: "BRL",
                }),
            ),
        ).toBe(true);

        expect(persisted?.version).toBe(2);

        // Verifica o Ledger diretamente no PostgreSQL.
        const ledgerRows =
            await orm.em.getConnection().execute(
                `
        select *
        from wallet_ledger_entries
        where wallet_id = ?
      `,
                [walletId],
            );

        expect(ledgerRows).toHaveLength(1);

        expect(ledgerRows[0]?.transaction_id)
            .toBe(transactionId);

        expect(ledgerRows[0]?.direction)
            .toBe("DEBIT");

        expect(ledgerRows[0]?.amount)
            .toBe("20.00");

        expect(ledgerRows[0]?.balance_before)
            .toBe("100.00");

        expect(ledgerRows[0]?.balance_after)
            .toBe("80.00");
    });
});
