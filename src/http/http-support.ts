import { BadRequestException, ConflictException, HttpException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { Money } from '../domain/money.js';
import { IdempotencyConflictError } from '../application/services/accept-wager.service.js';

export function object(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BadRequestException('Expected JSON object');
    return value as Record<string, unknown>;
}
export function identity(value: unknown): string {
    if (typeof value !== 'string' || !value.trim() || value.length > 255) throw new BadRequestException('Invalid identity');
    return value;
}
export function uuid(value: unknown): string {
    const id = identity(value);
    if (!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(id)) throw new BadRequestException('Invalid UUID');
    return id;
}
export function money(value: unknown): Money {
    const props = object(value);
    if (typeof props.amount !== 'string' || typeof props.currency !== 'string' || !/^\d{1,16}\.\d{2}$/.test(props.amount)) throw new BadRequestException('Money requires a nonnegative decimal string with 2 places (numeric(18,2))');
    try { return Money.from({ amount: props.amount, currency: props.currency }); }
    catch { throw new BadRequestException('Invalid money'); }
}
export function found<T>(value: T | null): T {
    if (value === null) throw new NotFoundException();
    return value;
}
export async function httpOperation<T>(operation: () => Promise<T>): Promise<T> {
    try { return await operation(); }
    catch (error) {
        if (error instanceof HttpException) throw error;
        if (error instanceof IdempotencyConflictError) throw new ConflictException({ code: error.code });
        throw new ServiceUnavailableException({ code: 'INFRASTRUCTURE_FAILURE', retryable: true });
    }
}
