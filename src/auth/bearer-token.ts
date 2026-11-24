import type { Request } from 'express';

/** The token of an `Authorization: Bearer …` header, if the request has one. */
export const bearerToken = (request: Request) => {
  const [type, token] = request.headers.authorization?.split(' ') ?? [];

  return type === 'Bearer' ? token : undefined;
};
