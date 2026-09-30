import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
export const SCOPE = 'transactions:suggest';
export interface AuthConfig {issuer:string;resource:string;jwksUrl:string;subjects:string[];origins:string[]}
export function createVerifier(config:AuthConfig, keys:JWTVerifyGetKey = createRemoteJWKSet(new URL(config.jwksUrl),{timeoutDuration:3000,cooldownDuration:30000})) {
  return async (token:string) => {
    const {payload} = await jwtVerify(token,keys,{issuer:config.issuer,audience:config.resource,algorithms:['RS256','ES256'],requiredClaims:['exp','iat','sub']});
    // Require resource scope and explicit membership; reject ID tokens as well.
    if (payload.token_use === 'id' || typeof payload.scope !== 'string' || !payload.scope.split(' ').includes(SCOPE) || !payload.sub || !config.subjects.includes(payload.sub)) throw new Error('Forbidden');
  };
}
