import { Body, Controller, Get, Inject, Param, Post, Query, BadRequestException, ConflictException } from '@nestjs/common';
import { MikroORM } from '@mikro-orm/postgresql';
import { Decimal } from 'decimal.js';
import { UniqueConstraintViolationException } from '@mikro-orm/core';
import { openWalletInTransaction } from '../application/services/open-wallet.service.js';
import { MikroOrmWalletRepository } from '../persistence/repositories/mikro-orm-wallet.repository.js';
import { found, httpOperation, identity, money, object, uuid } from './http-support.js';
import type { Wallet } from '../domain/wallet.js';

const view = (wallet: Wallet) => ({ id: wallet.id, playerId: wallet.playerId, balance: wallet.balance.toJSON(), version: wallet.version });
@Controller('wallets')
export class WalletController {
    constructor(@Inject(MikroORM) private readonly orm: MikroORM) {}
    @Post()
    create(@Body() body: unknown) {
        const input = object(body), playerId = identity(input.playerId), balance = money(input.initialBalance);
        if (balance.isZero()) throw new BadRequestException('Initial balance must be greater than zero');
        return httpOperation(async () => {
            try { return view(await this.orm.em.fork().transactional(tx => openWalletInTransaction(tx, playerId, balance))); }
            catch (error) {
                if (error instanceof UniqueConstraintViolationException) throw new ConflictException({ code: 'WALLET_ALREADY_EXISTS' });
                throw error;
            }
        });
    }
    @Get(':id')
    get(@Param('id') id: string) {
        uuid(id);
        return httpOperation(async () => view(found(await new MikroOrmWalletRepository(this.orm.em.fork()).findById(id))));
    }
    @Get(':id/ledger')
    ledger(@Param('id') id: string, @Query('cursor') cursor?: string, @Query('limit') rawLimit?: string) {
        uuid(id);
        const limit = rawLimit === undefined ? 50 : Number(rawLimit);
        if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new BadRequestException('limit must be 1..100');
        let after: { time: string; id: string } | undefined;
        if (cursor) {
            try {
                const decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString());
                if (decoded.walletId !== id || typeof decoded.time !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(decoded.time) || !Number.isFinite(Date.parse(decoded.time))) throw new Error();
                after = { time: decoded.time, id: uuid(decoded.id) };
            } catch { throw new BadRequestException('Invalid ledger cursor'); }
        }
        return httpOperation(async () => {
            const wallet = found(await new MikroOrmWalletRepository(this.orm.em.fork()).findById(id));
            const rows = await this.orm.em.getConnection().execute(
                `select *, to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as cursor_time from wallet_ledger_entries where wallet_id = ? ${after ? 'and (created_at, id) > (?::timestamptz, ?::uuid)' : ''} order by created_at, id limit ?`,
                [id, ...(after ? [after.time, after.id] : []), limit + 1]);
            const items = rows.slice(0, limit), last = items.at(-1);
            return { items: items.map((row: any) => ({ id: row.id, transactionId: row.transaction_id, direction: row.direction,
                money: { amount: row.amount, currency: wallet.currency }, balanceBefore: row.balance_before,
                balanceAfter: row.balance_after, createdAt: row.created_at })),
                nextCursor: rows.length > limit && last ? Buffer.from(JSON.stringify({ walletId: id, time: last.cursor_time, id: last.id })).toString('base64url') : null };
        });
    }
    @Get(':id/reconciliation')
    reconciliation(@Param('id') id: string) {
        uuid(id);
        return httpOperation(async () => {
            // One SQL statement gives the stored balance and ledger the same MVCC snapshot.
            const rows = await this.orm.em.getConnection().execute(`select w.balance, w.currency,
                coalesce(sum(case when l.direction = 'CREDIT' then l.amount else -l.amount end), 0)::text as calculated,
                count(l.id)::int as checked from wallets w left join wallet_ledger_entries l on l.wallet_id = w.id
                where w.id = ? group by w.id`, [id]);
            const row = found(rows[0] ?? null);
            const difference = new Decimal(row.balance).minus(row.calculated);
            return { walletId: id, storedBalance: { amount: row.balance, currency: row.currency },
                calculatedBalance: { amount: new Decimal(row.calculated).toFixed(2), currency: row.currency },
                difference: { amount: difference.toFixed(2), currency: row.currency }, consistent: difference.isZero(), checkedEntries: row.checked };
        });
    }
}
