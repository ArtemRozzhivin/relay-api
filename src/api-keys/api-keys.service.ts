import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service.js';
import type { Prisma } from '../generated/prisma/client.js';
import { lockAccount } from '../prisma/account-lock.js';
import {
  ApiKeyNotFoundError,
  ApiKeysDisabledError,
  TooManyApiKeysError,
} from '../common/errors/app-error.js';
import type { ApiEnv } from '../config/env.schema.js';
import { toPage } from '../common/pagination/cursor.js';
import { hashApiKey, mintApiKey } from './api-key-secret.js';
import { describeError } from '../common/errors/describe-error.js';
import type {
  CreateApiKeyInput,
  ListAllApiKeysQuery,
  RevokeMatchingInput,
} from './api-keys.schema.js';

// One system per seller, and one key to account for. Rotating it means
// revoking the old key before making the new one, so the seller's script is
// without a key in between.
const MAX_UNREVOKED = 1;

// How far behind a key's lastUsedAt may be: a key in a tight loop writes it
// once a minute, not once a request.
const LAST_USED_RESOLUTION_MS = 60_000;

// A key as its owner sees it: never the hash, which is all an attacker who
// read the table would need to recognise a key they hold.
const VIEW = {
  id: true,
  name: true,
  prefix: true,
  scopes: true,
  createdAt: true,
  lastUsedAt: true,
  revokedAt: true,
} satisfies Prisma.ApiKeySelect;

@Injectable()
export class ApiKeysService {
  private readonly logger = new Logger(ApiKeysService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<ApiEnv, true>,
  ) {}

  /**
   * Makes a key for the caller (§6.3f).
   *
   * @returns the key as its owner sees it, and `key`, the secret: returned by
   * this call and nowhere else, and never stored (A26).
   * @throws ApiKeysDisabledError (403) when the operator has turned API keys
   * off.
   * @throws TooManyApiKeysError (429) when the caller already holds an
   * unrevoked key.
   */
  async create(userId: string, { name, scopes }: CreateApiKeyInput) {
    if (!this.config.get('API_KEYS_ENABLED', { infer: true })) {
      throw new ApiKeysDisabledError();
    }

    const { key, prefix, hash } = mintApiKey();

    const created = await this.prisma.$transaction(async (tx) => {
      // Counted under the account's lock, so two requests at once cannot both
      // make the account's key (D32).
      await lockAccount(tx, userId);

      const unrevoked = await tx.apiKey.count({
        where: { userId, revokedAt: null },
      });

      if (unrevoked >= MAX_UNREVOKED) {
        throw new TooManyApiKeysError(MAX_UNREVOKED);
      }

      return tx.apiKey.create({
        data: { userId, name, scopes, prefix, hash },
        select: VIEW,
      });
    });

    return { ...created, key };
  }

  /**
   * The key a request presents, with its owner and scopes, or `null` when no
   * unrevoked key hashes to it (§6.3f). Read on every request and never
   * cached, so a revoke takes effect on the next one, on every API instance,
   * without a restart (A25).
   *
   * @throws ApiKeysDisabledError (403) while the operator has keys turned off.
   */
  async authenticate(key: string) {
    if (!this.config.get('API_KEYS_ENABLED', { infer: true })) {
      throw new ApiKeysDisabledError();
    }

    const found = await this.prisma.apiKey.findUnique({
      where: { hash: hashApiKey(key) },
      select: {
        id: true,
        scopes: true,
        revokedAt: true,
        lastUsedAt: true,
        user: { select: { id: true, email: true, role: true } },
      },
    });

    if (!found || found.revokedAt !== null) {
      return null;
    }

    this.noteUse(found.id, found.lastUsedAt);

    return found;
  }

  // Not awaited: a request is let in on its key, not on a timestamp, so a
  // failed write is logged rather than failing the request.
  private noteUse(id: string, lastUsedAt: Date | null) {
    const now = Date.now();

    if (lastUsedAt && now - lastUsedAt.getTime() < LAST_USED_RESOLUTION_MS) {
      return;
    }

    // Conditional on the column as well: two requests that both read the old
    // value write it once.
    this.prisma.apiKey
      .updateMany({
        where: {
          id,
          OR: [
            { lastUsedAt: null },
            { lastUsedAt: { lt: new Date(now - LAST_USED_RESOLUTION_MS) } },
          ],
        },
        data: { lastUsedAt: new Date(now) },
      })
      .catch((error: unknown) => {
        this.logger.warn(
          `Could not record the use of API key ${id}: ${describeError(error)}`,
        );
      });
  }

  /** The caller's keys, newest first, revoked ones included. */
  list(userId: string) {
    return this.prisma.apiKey.findMany({
      where: { userId },
      select: VIEW,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
  }

  /**
   * Revokes one of the caller's keys: from the next request on, it
   * authenticates nothing (A25). A key already revoked keeps the moment it
   * first was, so the answer to a retried revoke is the first one's.
   *
   * @throws ApiKeyNotFoundError (404) when the key does not exist or is
   * another account's.
   */
  async revoke(userId: string, id: string) {
    const [revoked] = await this.prisma.apiKey.updateManyAndReturn({
      where: { id, userId, revokedAt: null },
      data: { revokedAt: new Date() },
      select: VIEW,
    });

    if (revoked) {
      return revoked;
    }

    const existing = await this.prisma.apiKey.findFirst({
      where: { id, userId },
      select: VIEW,
    });

    if (!existing) {
      throw new ApiKeyNotFoundError();
    }

    return existing;
  }

  /**
   * Every account's keys, for the operator: newest first, with whose each is,
   * so a revoke is not made blind (§6.3f).
   */
  async findAll({ email, status, limit, cursor }: ListAllApiKeysQuery) {
    const rows = await this.prisma.apiKey.findMany({
      where: {
        ...(email === undefined ? {} : { user: { email } }),
        ...(status === undefined
          ? {}
          : { revokedAt: status === 'active' ? null : { not: null } }),
        // Strictly after the cursor in (createdAt, id) order, as GET /jobs.
        ...(cursor
          ? {
              OR: [
                { createdAt: { lt: cursor.createdAt } },
                { createdAt: cursor.createdAt, id: { lt: cursor.id } },
              ],
            }
          : {}),
      },
      select: { ...VIEW, user: { select: { id: true, email: true } } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });

    return toPage(
      rows.map(({ user, ...key }) => ({ ...key, owner: user })),
      limit,
      (key) => ({ createdAt: key.createdAt.toISOString(), id: key.id }),
    );
  }

  /**
   * The operator's answer to a leak: revokes every unrevoked key, or the
   * keys of the account with `email` (§6.3f). With `dryRun`, counts them and
   * revokes none. A key already revoked keeps the moment it first was.
   *
   * @param adminId who asked, for the log line that records it.
   * @returns how many keys matched, and how many this call revoked.
   */
  async revokeMatching(
    adminId: string,
    { email, dryRun }: RevokeMatchingInput,
  ) {
    const where: Prisma.ApiKeyWhereInput = {
      revokedAt: null,
      ...(email === undefined ? {} : { user: { email } }),
    };

    if (dryRun) {
      return { matched: await this.prisma.apiKey.count({ where }), revoked: 0 };
    }

    const { count } = await this.prisma.apiKey.updateMany({
      where,
      data: { revokedAt: new Date() },
    });

    // The account's id, not its email: a log line is no place for one.
    this.logger.warn(
      `Admin ${adminId} revoked ${count} API key(s) of ${email === undefined ? 'every account' : 'one account'}`,
    );

    return { matched: count, revoked: count };
  }
}
