import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { JWTPayload } from 'jose';
import type { Config } from '../config.js';

export interface VerifiedToken {
  claims: JWTPayload;
}

export interface TokenVerifier {
  verify(token: string): Promise<VerifiedToken>;
}

class TokenVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TokenVerificationError';
  }
}

export function createTokenVerifier(config: Config): TokenVerifier {
  const { mode, issuer, audience, jwksUri, hs256Secret } = config.auth;

  if (mode === 'hs256') {
    if (!hs256Secret) {
      throw new Error('AUTH_HS256_SECRET is required when AUTH_MODE=hs256');
    }
    const secret = new TextEncoder().encode(hs256Secret);
    return {
      async verify(token: string): Promise<VerifiedToken> {
        try {
          const { payload } = await jwtVerify(token, secret, {
            issuer,
            audience,
            algorithms: ['HS256'],
          });
          return { claims: payload };
        } catch {
          throw new TokenVerificationError('token verification failed');
        }
      },
    };
  }

  if (!jwksUri) {
    throw new Error('OIDC_JWKS_URI is required when AUTH_MODE=jwks');
  }
  const jwks = createRemoteJWKSet(new URL(jwksUri));
  return {
    async verify(token: string): Promise<VerifiedToken> {
      try {
        const { payload } = await jwtVerify(token, jwks, {
          issuer,
          audience,
        });
        return { claims: payload };
      } catch {
        throw new TokenVerificationError('token verification failed');
      }
    },
  };
}

export { TokenVerificationError };
