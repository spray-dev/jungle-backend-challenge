import {
    afterAll,
    beforeAll,
    expect,
    it,
} from "bun:test";

import {
    MikroORM,
} from "@mikro-orm/postgresql";

import {
    createTestOrm,
    closeTestOrm,
} from "../../testing/integration-database.js";

import { Money } from "../../domain/money.js";
import { Wallet } from "../../domain/wallet.js";
import { WagerTransactionStatus } from "../../domain/wager-transaction.js";

import { MikroOrmWalletRepository } from "../../persistence/repositories/mikro-orm-wallet.repository.js";

import {
    HandleWagerMessageService,
    InboxPayloadConflictError,
    type HandleWagerMessageCommand,
} from "./handle-wager-message.service.js";

import {
    ForeignKeyConstraintViolationException,
} from "@mikro-orm/core";

let orm: MikroORM;

beforeAll(async () => {
    orm = await createTestOrm();
}, 30000);

afterAll(async () => {
    await closeTestOrm(orm);
});

async function command():
    Promise<HandleWagerMessageCommand> {
    const walletId =
        crypto.randomUUID();

    const playerId =
        `player-${walletId}`;

    await new MikroOrmWalletRepository(
        orm.em.fork(),
    ).create(
        Wallet.open({
            id: walletId,
            playerId,

            initialBalance:
                Money.from({
                    amount: "100.00",
                    currency: "BRL",
                }),
        }),
    );

    const transactionId =
        crypto.randomUUID();

    return {
        consumerName:
            "wager-transactions-consumer",

        messageId:
            crypto.randomUUID(),

        payloadHash:
            "a".repeat(64),

        wager: {
            providerId:
                "provider",

            externalTransactionId:
                transactionId,

            idempotencyKey:
                transactionId,

            walletId,
            playerId,

            roundId:
                "round",

            gameId:
                "game",

            money: {
                amount: "20.00",
                currency: "BRL",
            },
        },
    };
}

it("commits inbox, wager, wallet and ledger together", async () => {
    const input =
        await command();

    const result =
        await new HandleWagerMessageService(
            orm.em.fork(),
        ).execute(input);

    expect(
        result.transaction.status,
    ).toBe(
        WagerTransactionStatus.Processed,
    );

    expect(
        result.transaction
            .observedBalance
            ?.toJSON(),
    ).toEqual({
        amount: "80.00",
        currency: "BRL",
    });

    expect(
        result.duplicateMessage,
    ).toBe(false);

    expect(
        result.idempotentReplay,
    ).toBe(false);

    const inboxRows =
        await orm.em
            .getConnection()
            .execute(
                `
                    select *
                    from inbox_messages
                    where consumer_name = ?
                      and message_id = ?
                `,
                [
                    input.consumerName,
                    input.messageId,
                ],
            );

    expect(inboxRows)
        .toHaveLength(1);

    expect(
        inboxRows[0]?.processed_at,
    ).not.toBeNull();

    const walletRows =
        await orm.em
            .getConnection()
            .execute(
                `
                    select balance
                    from wallets
                    where id = ?
                `,
                [
                    input.wager.walletId,
                ],
            );

    expect(
        walletRows[0]?.balance,
    ).toBe("80.00");

    const ledgerRows =
        await orm.em
            .getConnection()
            .execute(
                `
                    select *
                    from wallet_ledger_entries
                    where wallet_id = ?
                `,
                [
                    input.wager.walletId,
                ],
            );

    expect(ledgerRows)
        .toHaveLength(1);
});

it("replays the same message without debiting twice", async () => {
    const input =
        await command();

    const service =
        new HandleWagerMessageService(
            orm.em.fork(),
        );

    const first =
        await service.execute(
            input,
        );

    const replay =
        await service.execute(
            input,
        );

    expect(replay.transaction.id)
        .toBe(first.transaction.id);

    expect(
        replay.duplicateMessage,
    ).toBe(true);

    expect(
        replay.idempotentReplay,
    ).toBe(true);

    expect(
        replay.transaction
            .observedBalance
            ?.toJSON(),
    ).toEqual({
        amount: "80.00",
        currency: "BRL",
    });

    const ledgerRows =
        await orm.em
            .getConnection()
            .execute(
                `
                    select id
                    from wallet_ledger_entries
                    where wallet_id = ?
                `,
                [
                    input.wager.walletId,
                ],
            );

    expect(ledgerRows)
        .toHaveLength(1);
});

it("rejects the same message identity with a different payload hash", async () => {
    const input =
        await command();

    const service =
        new HandleWagerMessageService(
            orm.em.fork(),
        );

    await service.execute(
        input,
    );

    await expect(
        service.execute({
            ...input,

            payloadHash:
                "b".repeat(64),
        }),
    ).rejects.toBeInstanceOf(
        InboxPayloadConflictError,
    );

    const ledgerRows =
        await orm.em
            .getConnection()
            .execute(
                `
                    select id
                    from wallet_ledger_entries
                    where wallet_id = ?
                `,
                [
                    input.wager.walletId,
                ],
            );

    expect(ledgerRows)
        .toHaveLength(1);
});

it("rolls back inbox when wager persistence fails", async () => {
    const input =
        await command();

    /*
     * Wallet inexistente:
     * acceptBet insere a wager,
     * mas processBet falha depois.
     *
     * A transaction inteira precisa voltar.
     */
    const missingWalletId =
        crypto.randomUUID();

    const broken: HandleWagerMessageCommand = {
        ...input,

        messageId:
            crypto.randomUUID(),

        payloadHash:
            "c".repeat(64),

        wager: {
            ...input.wager,

            walletId:
                missingWalletId,
        },
    };

    await expect(
        new HandleWagerMessageService(
            orm.em.fork(),
        ).execute(
            broken,
        ),
    ).rejects.toBeInstanceOf(
        ForeignKeyConstraintViolationException,
    );

    const inboxRows =
        await orm.em
            .getConnection()
            .execute(
                `
                    select *
                    from inbox_messages
                    where consumer_name = ?
                      and message_id = ?
                `,
                [
                    broken.consumerName,
                    broken.messageId,
                ],
            );

    expect(inboxRows)
        .toHaveLength(0);

    const wagerRows =
        await orm.em
            .getConnection()
            .execute(
                `
                    select *
                    from wager_transactions
                    where provider_id = ?
                      and external_transaction_id = ?
                `,
                [
                    broken.wager.providerId,
                    broken.wager
                        .externalTransactionId,
                ],
            );

    expect(wagerRows)
        .toHaveLength(0);
});