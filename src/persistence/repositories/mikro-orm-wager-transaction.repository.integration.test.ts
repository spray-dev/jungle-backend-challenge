import {
    afterAll,
    afterEach,
    beforeAll,
    describe,
    expect,
    it,
} from "bun:test";

import { MikroORM } from "@mikro-orm/postgresql";

import config from "../../mikro-orm.config.js";
import { Money } from "../../domain/money.js";
import { Wallet } from "../../domain/wallet.js";

import {
    WagerTransaction,
    WagerTransactionKind,
    WagerTransactionStatus,
} from "../../domain/wager-transaction.js";

import { MikroOrmWalletRepository } from "./mikro-orm-wallet.repository.js";
import { MikroOrmWagerTransactionRepository } from "./mikro-orm-wager-transaction.repository.js";

let orm: MikroORM;

const walletIds = new Set<string>();
const wagerIds = new Set<string>();

beforeAll(async () => {
    orm = await MikroORM.init(config);
});

afterEach(async () => {
    for (const id of wagerIds) {
        await orm.em.getConnection().execute(
            `delete from wager_transactions where id = ?`,
            [id],
        );
    }

    for (const id of walletIds) {
        await orm.em.getConnection().execute(
            `delete from wallets where id = ?`,
            [id],
        );
    }

    wagerIds.clear();
    walletIds.clear();
});

afterAll(async () => {
    await orm.close();
});

async function createWallet(): Promise<string> {
    const id = crypto.randomUUID();

    walletIds.add(id);

    const now = new Date();

    const wallet = Wallet.rehydrate({
        id,
        playerId: `player-${id}`,
        currency: "BRL",
        balance: Money.from({
            amount: "100.00",
            currency: "BRL",
        }),
        version: 1,
        createdAt: now,
        updatedAt: now,
    });

    const repository =
        new MikroOrmWalletRepository(orm.em.fork());

    await repository.create(wallet);

    return id;
}

function createWager(
    walletId: string,
): WagerTransaction {
    const id = crypto.randomUUID();

    wagerIds.add(id);

    return WagerTransaction.create({
        id,
        providerId: "provider-1",
        externalTransactionId: crypto.randomUUID(),
        idempotencyKey: crypto.randomUUID(),
        payloadHash: "payload-hash",
        walletId,
        playerId: `player-${walletId}`,
        roundId: "round-1",
        gameId: "game-1",
        kind: WagerTransactionKind.Bet,
        money: Money.from({
            amount: "20.00",
            currency: "BRL",
        }),
        createdAt: new Date(),
    });
}

describe("MikroOrmWagerTransactionRepository integration", () => {
    it("inserts and reads a wager transaction", async () => {
        const walletId = await createWallet();

        const repository =
            new MikroOrmWagerTransactionRepository(
                orm.em.fork(),
            );

        const wager = createWager(walletId);

        await repository.insert(wager);

        const loaded =
            await repository.findById(wager.id);

        expect(loaded).not.toBeNull();
        expect(loaded?.id).toBe(wager.id);
        expect(loaded?.kind)
            .toBe(WagerTransactionKind.Bet);
        expect(loaded?.status)
            .toBe(WagerTransactionStatus.Pending);

        expect(
            loaded?.money.equals(
                Money.from({
                    amount: "20.00",
                    currency: "BRL",
                }),
            ),
        ).toBe(true);
    });

    it("updates a wager from PENDING to PROCESSED", async () => {
        const walletId = await createWallet();

        const repository =
            new MikroOrmWagerTransactionRepository(
                orm.em.fork(),
            );

        const wager = createWager(walletId);

        await repository.insert(wager);

        const loaded =
            await repository.findById(wager.id);

        if (loaded === null) {
            throw new Error("Wager transaction not found");
        }

        const expectedStatus = loaded.status;

        loaded.markProcessed(
            undefined,
            new Date(),
        );

        await repository.update(
            loaded,
            expectedStatus,
        );

        const verificationRepository =
            new MikroOrmWagerTransactionRepository(
                orm.em.fork(),
            );

        const persisted =
            await verificationRepository.findById(
                wager.id,
            );

        expect(persisted?.status)
            .toBe(WagerTransactionStatus.Processed);

        expect(persisted?.processedAt)
            .toBeDefined();
    });

    it("rejects a stale status update", async () => {
        const walletId = await createWallet();

        const setupRepository =
            new MikroOrmWagerTransactionRepository(
                orm.em.fork(),
            );

        const wager = createWager(walletId);

        await setupRepository.insert(wager);

        const repositoryA =
            new MikroOrmWagerTransactionRepository(
                orm.em.fork(),
            );

        const repositoryB =
            new MikroOrmWagerTransactionRepository(
                orm.em.fork(),
            );

        const wagerA =
            await repositoryA.findById(wager.id);

        const wagerB =
            await repositoryB.findById(wager.id);

        if (wagerA === null || wagerB === null) {
            throw new Error("Wager transaction not found");
        }

        const expectedStatusA = wagerA.status;
        const expectedStatusB = wagerB.status;

        wagerA.markProcessed(
            undefined,
            new Date(),
        );

        wagerB.markProcessed(
            undefined,
            new Date(),
        );

        await repositoryA.update(
            wagerA,
            expectedStatusA,
        );

        await expect(
            repositoryB.update(
                wagerB,
                expectedStatusB,
            ),
        ).rejects.toThrow(
            "Wager transaction concurrency conflict",
        );
    });
});