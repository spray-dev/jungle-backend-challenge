import { describe, expect, test } from "bun:test";
import { Money } from "./money.js";
import { Wallet, type WalletState } from "./wallet.js";

const money = (amount: string, currency = "BRL") => Money.from({ amount, currency });
const openWallet = (amount = "100.00", currency = "BRL") => Wallet.open({
    id: "wallet-1",
    playerId: "player-1",
    initialBalance: money(amount, currency),
});

describe("Wallet.open", () => {
    test("preserva identidade, saldo inicial e moeda, com version 1", () => {
        const wallet = openWallet();

        expect(wallet.id).toBe("wallet-1");
        expect(wallet.playerId).toBe("player-1");
        expect(wallet.currency).toBe("BRL");
        expect(wallet.balance.toJSON()).toEqual({ amount: "100.00", currency: "BRL" });
        expect(wallet.version).toBe(1);
        expect(wallet.createdAt).toBeInstanceOf(Date);
        expect(wallet.updatedAt).toEqual(wallet.createdAt);
    });

    test.each(["0.00", "-0.00"])("aceita saldo inicial zero (%s)", (amount) => {
        const wallet = openWallet(amount);
        expect(wallet.balance.isZero()).toBe(true);
        expect(wallet.version).toBe(1);
    });

    test("rejeita saldo inicial negativo", () => {
        expect(() => openWallet("-0.01")).toThrow("Initial balance cannot be negative");
    });

    test("usa a moeda normalizada pelo Money", () => {
        const wallet = openWallet("100.00", " brl ");
        expect(wallet.currency).toBe("BRL");
        wallet.credit(money("1.00"));
        expect(wallet.balance.toJSON()).toEqual({ amount: "101.00", currency: "BRL" });
    });
});

describe("Wallet.debit / Wallet.credit", () => {
    test("debit reduz o saldo, incrementa a versão e retorna dados da movimentação", () => {
        const wallet = openWallet();
        const before = wallet.balance;
        const amount = money("25.00");
        const movement = wallet.debit(amount);

        expect(wallet.balance.toJSON()).toEqual({ amount: "75.00", currency: "BRL" });
        expect(wallet.version).toBe(2);
        expect(movement).toEqual({
            walletId: wallet.id,
            direction: "DEBIT",
            money: amount,
            balanceBefore: before,
            balanceAfter: wallet.balance,
            walletVersion: 2,
        });
        expect(before.toJSON().amount).toBe("100.00");
    });

    test("credit aumenta o saldo, incrementa a versão e retorna dados da movimentação", () => {
        const wallet = openWallet();
        const before = wallet.balance;
        const amount = money("10.50");
        const movement = wallet.credit(amount);

        expect(wallet.balance.toJSON()).toEqual({ amount: "110.50", currency: "BRL" });
        expect(wallet.version).toBe(2);
        expect(movement).toEqual({
            walletId: wallet.id,
            direction: "CREDIT",
            money: amount,
            balanceBefore: before,
            balanceAfter: wallet.balance,
            walletVersion: 2,
        });
    });

    test("permite debitar exatamente o saldo disponível", () => {
        const wallet = openWallet();
        wallet.debit(money("100.00"));
        expect(wallet.balance.isZero()).toBe(true);
        expect(wallet.version).toBe(2);
    });

    test("rejeita saldo insuficiente sem alterar o estado", () => {
        const wallet = openWallet();
        const before = wallet.balance;
        const updatedAt = wallet.updatedAt;

        expect(() => wallet.debit(money("100.01"))).toThrow("Insufficient balance");
        expect(wallet.balance).toBe(before);
        expect(wallet.version).toBe(1);
        expect(wallet.updatedAt).toEqual(updatedAt);
    });

    for (const operation of ["debit", "credit"] as const) {
        test.each(["0.01", "0.06"])(`${operation} rejeita perda de precisão (%s) sem alterar o estado`, (amount) => {
            const wallet = openWallet("1000000000000000000.50");
            const before = wallet.balance;
            const updatedAt = wallet.updatedAt;

            expect(() => wallet[operation](money(amount))).toThrow("Movement exceeds money precision");
            expect(wallet.balance).toBe(before);
            expect(wallet.version).toBe(1);
            expect(wallet.updatedAt).toEqual(updatedAt);
        });

        test.each(["1.00", "0.00"])(`${operation} rejeita moeda incompatível (%s) sem alterar o estado`, (amount) => {
            const wallet = openWallet();
            const before = wallet.balance;
            const updatedAt = wallet.updatedAt;

            expect(() => wallet[operation](money(amount, "USD"))).toThrow("Currency mismatch");
            expect(wallet.balance).toBe(before);
            expect(wallet.version).toBe(1);
            expect(wallet.updatedAt).toEqual(updatedAt);
        });

        test(`${operation} rejeita valor negativo sem alterar o estado`, () => {
            const wallet = openWallet();
            const before = wallet.balance;
            const updatedAt = wallet.updatedAt;

            expect(() => wallet[operation](money("-0.01"))).toThrow("Movement amount cannot be negative");
            expect(wallet.balance).toBe(before);
            expect(wallet.version).toBe(1);
            expect(wallet.updatedAt).toEqual(updatedAt);
        });

        test.each(["0.00", "-0.00"])(`${operation} com zero (%s) retorna null e preserva o estado`, (amount) => {
            const wallet = openWallet();
            const before = wallet.balance;
            const updatedAt = wallet.updatedAt;

            expect(wallet[operation](money(amount))).toBeNull();
            expect(wallet.balance).toBe(before);
            expect(wallet.version).toBe(1);
            expect(wallet.updatedAt).toEqual(updatedAt);
        });
    }

    test("incrementa uma vez por mudança e preserva os dados de movimentações anteriores", () => {
        const wallet = openWallet("0.30");
        const movement = wallet.debit(money("0.10"));
        expect(wallet.version).toBe(2);
        wallet.credit(money("0.20"));
        expect(wallet.version).toBe(3);
        wallet.credit(money("0.00"));
        expect(wallet.version).toBe(3);
        expect(wallet.balance.toJSON().amount).toBe("0.40");
        expect(movement?.balanceBefore.toJSON().amount).toBe("0.30");
        expect(movement?.balanceAfter.toJSON().amount).toBe("0.20");
        expect(movement?.walletVersion).toBe(2);
    });
});

describe("Wallet.rehydrate", () => {
    const state = (): WalletState => ({
        id: "wallet-saved",
        playerId: "player-saved",
        currency: "USD",
        balance: money("42.50", "USD"),
        version: 7,
        createdAt: new Date("2026-01-01T10:00:00.000Z"),
        updatedAt: new Date("2026-01-02T10:00:00.000Z"),
    });

    test("reconstrói o estado salvo sem reiniciar versão ou datas", () => {
        const saved = state();
        const wallet = Wallet.rehydrate(saved);

        expect(wallet.id).toBe(saved.id);
        expect(wallet.playerId).toBe(saved.playerId);
        expect(wallet.currency).toBe(saved.currency);
        expect(wallet.balance).toBe(saved.balance);
        expect(wallet.version).toBe(7);
        expect(wallet.createdAt).toEqual(saved.createdAt);
        expect(wallet.updatedAt).toEqual(saved.updatedAt);
    });

    test.each(["debit", "credit"] as const)("%s continua da versão salva e atualiza a data", (operation) => {
        const saved = state();
        const wallet = Wallet.rehydrate(saved);
        wallet[operation](money("2.50", "USD"));

        expect(wallet.balance.toJSON().amount).toBe(operation === "debit" ? "40.00" : "45.00");
        expect(wallet.version).toBe(8);
        expect(wallet.updatedAt.getTime()).toBeGreaterThan(saved.updatedAt.getTime());
        expect(wallet.createdAt).toEqual(saved.createdAt);
    });

    test("protege as datas contra mutação externa", () => {
        const saved = state();
        const wallet = Wallet.rehydrate(saved);
        saved.createdAt.setFullYear(2000);
        saved.updatedAt.setFullYear(2000);
        wallet.createdAt.setFullYear(2001);
        wallet.updatedAt.setFullYear(2001);

        expect(wallet.createdAt.toISOString()).toBe("2026-01-01T10:00:00.000Z");
        expect(wallet.updatedAt.toISOString()).toBe("2026-01-02T10:00:00.000Z");
    });
});
