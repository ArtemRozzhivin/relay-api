import { Role } from '../generated/prisma/enums.js';

export interface AccessTokenPayload {
  sub: string;
  email: string;
  role: Role;
  iat: number;
  exp: number;
}

export interface AuthenticatedUser {
  id: string;
  email: string;
  role: Role;
  /** Set when the request authenticated with an API key rather than a login. */
  apiKeyId?: string;
}
