import { SignJWT } from 'jose';
import { createTokenVerifier, type Config, type TokenVerifier } from '@aip/api';
import type { Permission } from '@aip/contracts';

/** 一次性测试密钥：只用于隔离测试进程，不对应任何真实身份系统。 */
export const TEST_HS256_SECRET = 'aip-test-only-hs256-secret';
export const TEST_ISSUER = 'https://issuer.test/aip';
export const TEST_AUDIENCE = 'aip-test-audience';

export const ALL_PERMISSIONS: Permission[] = [
  'asset:read',
  'asset:write',
  'asset:manage',
  'asset:bind',
  'knowledge:read',
  'knowledge:write',
  'knowledge:review',
  'knowledge:manage',
  'source:read',
  'operations:read',
];

export const WRITER_PERMISSIONS: Permission[] = [
  'asset:read',
  'asset:write',
  'asset:bind',
  'knowledge:read',
  'knowledge:write',
  'source:read',
];

export const REVIEWER_PERMISSIONS: Permission[] = [
  'knowledge:read',
  'knowledge:review',
  'operations:read',
];

const secret = new TextEncoder().encode(TEST_HS256_SECRET);

export interface TokenOptions {
  subject: string;
  scope: string;
  permissions: readonly string[];
  /** 相对当前时间的过期秒数；负数表示已过期。 */
  expiresInSeconds?: number;
  issuer?: string;
  audience?: string;
  /** 覆盖签发者，用于伪造 token 的负例。 */
  signedWith?: string;
  /** 直接覆盖原始 scope 声明，用于多 scope 等非法形态的负例。 */
  scopeClaim?: unknown;
}

export async function mintToken(options: TokenOptions): Promise<string> {
  const key = new TextEncoder().encode(options.signedWith ?? TEST_HS256_SECRET);
  const expiresIn = options.expiresInSeconds ?? 300;
  return new SignJWT({
    scope: options.scopeClaim ?? options.scope,
    permissions: options.permissions,
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer(options.issuer ?? TEST_ISSUER)
    .setAudience(options.audience ?? TEST_AUDIENCE)
    .setSubject(options.subject)
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + expiresIn)
    .sign(key);
}

/** 使用与生产同一条校验路径（jose HS256 + issuer/audience 校验）。 */
export function createTestVerifier(secret: string = TEST_HS256_SECRET): TokenVerifier {
  const config = {
    auth: {
      mode: 'hs256',
      issuer: TEST_ISSUER,
      audience: TEST_AUDIENCE,
      jwksUri: '',
      hs256Secret: secret,
    },
  } as unknown as Config;
  return createTokenVerifier(config);
}
