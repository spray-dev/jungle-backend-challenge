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
import { WalletLedgerEntry } from "../../domain/wallet-ledger-entry.js";

import { MikroOrmWalletRepository } from "./mikro-orm-wallet.repository.js";
import { MikroOrmWalletLedgerRepository } from "./mikro-orm-wallet-ledger.repository.js";
import { createWagerFixture } from "../../testing/create-wager-fixture.js";

let orm: MikroORM;


beforeAll(async () => {
    orm = await createTestOrm();
}, 30000);


afterAll(async () => {
    await closeTestOrm(orm);
});

describe("MikroOrmWalletLedgerRepository integration", () => {
    it("inserts a valid ledger entry", async () => {
        const em = orm.em.fork();

        const walletRepository =
            new MikroOrmWalletRepository(em);

        const ledgerRepository =
            new MikroOrmWalletLedgerRepository(em);

        const walletId = crypto.randomUUID();
        const ledgerId = crypto.randomUUID();
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

        await walletRepository.create(wallet);
        await createWagerFixture(em, walletId, transactionId);

        const entry = WalletLedgerEntry.create({
            id: ledgerId,
            walletId,
            transactionId,
            direction: "DEBIT",
            amount: Money.from({
                amount: "20.00",
                currency: "BRL",
            }),
            balanceBefore: Money.from({
                amount: "100.00",
                currency: "BRL",
            }),
            balanceAfter: Money.from({
                amount: "80.00",
                currency: "BRL",
            }),
            createdAt: now,
        });

        await ledgerRepository.insert(entry);

        const rows = await em.getConnection().execute(
            `
        select *
        from wallet_ledger_entries
        where id = ?
      `,
            [ledgerId],
        );

        expect(rows).toHaveLength(1);
        expect(rows[0]?.wallet_id).toBe(walletId);
        expect(rows[0]?.direction).toBe("DEBIT");
        expect(rows[0]?.amount).toBe("20.00");
        expect(rows[0]?.balance_before).toBe("100.00");
        expect(rows[0]?.balance_after).toBe("80.00");
    });
});
