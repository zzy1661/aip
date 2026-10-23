import { describe, expect, it } from 'vitest';
import { toDatabaseApiError } from '@aip/api';

/**
 * M-7 配套：数据库错误必须落成明确的 4xx / 503，不得混成 500。
 */
describe('数据库错误映射', () => {
  it('22P02 落成 400 BAD_REQUEST', () => {
    const mapped = toDatabaseApiError({ code: '22P02', message: 'invalid input syntax for type uuid' });
    expect(mapped).not.toBeNull();
    expect(mapped!.code).toBe('BAD_REQUEST');
    expect(mapped!.status).toBe(400);
  });

  it('57014 落成 503 DB_UNAVAILABLE', () => {
    const mapped = toDatabaseApiError({ code: '57014', message: 'canceling statement due to statement timeout' });
    expect(mapped!.code).toBe('DB_UNAVAILABLE');
    expect(mapped!.status).toBe(503);
  });

  it('55P03 落成 503 DB_UNAVAILABLE', () => {
    const mapped = toDatabaseApiError({ code: '55P03', message: 'could not obtain lock on row' });
    expect(mapped!.code).toBe('DB_UNAVAILABLE');
    expect(mapped!.status).toBe(503);
  });

  it('其它错误不映射', () => {
    expect(toDatabaseApiError({ code: '23505' })).toBeNull();
    expect(toDatabaseApiError(new Error('boom'))).toBeNull();
    expect(toDatabaseApiError(null)).toBeNull();
  });
});
