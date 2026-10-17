import { Body, Controller, Get, Headers, Inject, Param, Post, Res, BadRequestException } from '@nestjs/common';
import { MikroORM } from '@mikro-orm/postgresql';
import { acceptWagerInTransaction, type AcceptWagerCommand } from '../application/services/accept-wager.service.js';
import { processWagerInTransaction } from '../application/services/process-wager.service.js';
import { enqueueWagerEvent } from '../application/services/enqueue-wager-event.js';
import { ConcurrencyConflictError } from '../domain/ports/concurrency-conflict.error.js';
import { MikroOrmWalletRepository } from '../persistence/repositories/mikro-orm-wallet.repository.js';
import { MikroOrmWagerTransactionRepository } from '../persistence/repositories/mikro-orm-wager-transaction.repository.js';
import type { WagerTransaction } from '../domain/wager-transaction.js';
import { found, httpOperation, identity, money, object, uuid } from './http-support.js';

function view(transaction: WagerTransaction) {
    return { transactionId: transaction.id, status: transaction.status, balance: transaction.observedBalance?.toJSON(),
        failureCode: transaction.failureCode, kind: transaction.kind, walletId: transaction.walletId,
        providerId: transaction.providerId, externalTransactionId: transaction.externalTransactionId,
        money: transaction.money.toJSON() };
}
@Controller()
export class WagerController {
    constructor(@Inject(MikroORM) private readonly orm: MikroORM) {}
    @Post('wagering/transactions')
    submit(@Body() body: unknown, @Headers('idempotency-key') key: unknown,
        @Res({ passthrough: true }) response: { status(code: number): unknown }) {
        const input = object(body);
        const kind = identity(input.kind);
        if (!['BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK'].includes(kind)) throw new BadRequestException('Unsupported wager kind');
        const reference = input.referenceExternalTransactionId === undefined ? undefined : identity(input.referenceExternalTransactionId);
        if (['REFUND', 'ROLLBACK'].includes(kind) && reference === undefined) throw new BadRequestException('Reference required');
        const command: AcceptWagerCommand = { kind: kind as AcceptWagerCommand['kind'],
            idempotencyKey: identity(key), providerId: identity(input.providerId), externalTransactionId: identity(input.externalTransactionId),
            playerId: identity(input.playerId), walletId: uuid(input.walletId), roundId: identity(input.roundId), gameId: identity(input.gameId),
            money: money(input.money).toJSON(), referenceExternalTransactionId: reference };
        return httpOperation(async () => {
            for (let attempt = 1; ; attempt++) {
                try {
                    const result = await this.orm.em.fork().transactional(async tx => {
                        found(await new MikroOrmWalletRepository(tx).findById(command.walletId));
                        const accepted = await acceptWagerInTransaction(tx, command);
                        const terminal = accepted.transaction.isTerminal();
                        const transaction = await processWagerInTransaction(tx, accepted.transaction.id);
                        if (!transaction.requiresReference() && !terminal) await enqueueWagerEvent(tx, transaction, new Date());
                        return { ...view(transaction), idempotentReplay: accepted.idempotentReplay };
                    }, { clear: true });
                    response.status(result.status === 'REJECTED' ? 422 : result.status === 'PENDING_REFERENCE' || result.status === 'PENDING' ? 202 : 200);
                    return result;
                } catch (error) {
                    if (!(error instanceof ConcurrencyConflictError) || attempt >= 5) throw error;
                }
            }
        });
    }
    @Get(['wagering/transactions/provider/:providerId/external/:externalTransactionId', 'providers/:providerId/wagering/transactions/:externalTransactionId'])
    byExternal(@Param('providerId') providerId: string, @Param('externalTransactionId') external: string) {
        identity(providerId); identity(external);
        return httpOperation(async () => view(found(await new MikroOrmWagerTransactionRepository(this.orm.em.fork()).findByProviderAndExternalTransactionId(providerId, external))));
    }
    @Get('wagering/transactions/:id')
    get(@Param('id') id: string) {
        uuid(id);
        return httpOperation(async () => view(found(await new MikroOrmWagerTransactionRepository(this.orm.em.fork()).findById(id))));
    }
}
