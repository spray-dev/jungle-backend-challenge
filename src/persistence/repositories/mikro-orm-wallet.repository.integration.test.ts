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
import { MikroOrmWalletRepository } from "./mikro-orm-wallet.repository.js";

let orm: MikroORM;


function makeWallet(
    id: string,
    balance = "100.00",
): Wallet {
    const now = new Date();

    return Wallet.rehydrate({
        id,
        playerId: `player-${id}`,
        currency: "BRL",
        balance: Money.from({
            amount: balance,
            currency: "BRL",
        }),
        version: 1,
        createdAt: now,
        updatedAt: now,
    });
}

beforeAll(async () => {
    orm = await createTestOrm();
}, 30000);


afterAll(async () => {
    await closeTestOrm(orm);
});

describe("MikroOrmWalletRepository integration", () => {
    it("creates and reads a wallet from PostgreSQL", async () => {
        const repository = new MikroOrmWalletRepository(
            orm.em.fork(),
        );

        const id = crypto.randomUUID();


        const wallet = makeWallet(id);

        await repository.create(wallet);

        const loaded = await repository.findById(id);

        expect(loaded).not.toBeNull();
        expect(loaded?.id).toBe(id);
        expect(loaded?.playerId).toBe(wallet.playerId);
        expect(loaded?.currency).toBe("BRL");
        expect(
            loaded?.balance.equals(
                Money.from({
                    amount: "100.00",
                    currency: "BRL",
                }),
            ),
        ).toBe(true);
        expect(loaded?.version).toBe(1);
    });

    it("updates a wallet using the expected version", async () => {
        const repository = new MikroOrmWalletRepository(
            orm.em.fork(),
        );

        const id = crypto.randomUUID();


        await repository.create(makeWallet(id));

        const wallet = await repository.findById(id);

        if (wallet === null) {
            throw new Error("Wallet was not found");
        }

        const expectedVersion = wallet.version;

        wallet.debit(
            Money.from({
                amount: "20.00",
                currency: "BRL",
            }),
        );

        await repository.update(wallet, expectedVersion);

        const reloadedRepository =
            new MikroOrmWalletRepository(orm.em.fork());

        const reloaded =
            await reloadedRepository.findById(id);

        expect(reloaded).not.toBeNull();

        expect(
            reloaded?.balance.equals(
                Money.from({
                    amount: "80.00",
                    currency: "BRL",
                }),
            ),
        ).toBe(true);

        expect(reloaded?.version).toBe(2);
    });

    it("rejects a stale concurrent update", async () => {
        const setupRepository =
            new MikroOrmWalletRepository(orm.em.fork());

        const id = crypto.randomUUID();


        await setupRepository.create(makeWallet(id));

        // Simulam duas requisições independentes.
        const repositoryA =
            new MikroOrmWalletRepository(orm.em.fork());

        const repositoryB =
            new MikroOrmWalletRepository(orm.em.fork());

        const walletA = await repositoryA.findById(id);
        const walletB = await repositoryB.findById(id);

        if (walletA === null || walletB === null) {
            throw new Error("Wallet was not found");
        }

        const versionA = walletA.version;
        const versionB = walletB.version;

        walletA.debit(
            Money.from({
                amount: "20.00",
                currency: "BRL",
            }),
        );

        walletB.debit(
            Money.from({
                amount: "30.00",
                currency: "BRL",
            }),
        );

        await repositoryA.update(walletA, versionA);

        await expect(
            repositoryB.update(walletB, versionB),
        ).rejects.toThrow("Wallet concurrency conflict");

        const verificationRepository =
            new MikroOrmWalletRepository(orm.em.fork());

        const persisted =
            await verificationRepository.findById(id);

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
    });
});