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
}
