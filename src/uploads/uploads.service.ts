import { Injectable } from '@nestjs/common';
import { StorageService } from '../storage/storage.service.js';
import { mintUploadKey } from '../storage/object-keys.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { lockAccount } from '../prisma/account-lock.js';
import { TooManyUploadsError } from '../common/errors/app-error.js';

// Far beyond the 20 000-row catalog PB is built for, and small enough that a
// wrong file — a video, a database dump — is refused by S3 before it is stored.
export const UPLOAD_MAX_BYTES = 50 * 1024 * 1024;

// Long enough to pick a file and send it on a slow connection; short enough
// that a leaked link is useless soon after.
const UPLOAD_EXPIRES_IN_SECONDS = 300;

// A store that re-uploads after a mistake or two still has room many times
// over. The bucket keeps an upload 7 days, so this holds what one account can
// keep there to some 8 GB (D32).
export const UPLOAD_SLIPS_PER_DAY = 20;

const DAY_MS = 24 * 60 * 60 * 1000;

@Injectable()
export class UploadsService {
  constructor(
    private readonly storage: StorageService,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * Mints a key under the caller's own prefix and signs an upload to it.
   *
   * The caller never chooses the key, so it can neither overwrite another
   * tenant's file nor name a path an import would later trust.
   *
   * @throws TooManyUploadsError (429) when the caller has started
   * {@link UPLOAD_SLIPS_PER_DAY} uploads in the last 24 hours (D32).
   */
  async createUpload(userId: string) {
    const key = mintUploadKey(userId);

    // Signed inside the transaction and handed out only once it commits: no
    // slip leaves uncounted, and one that fails to sign rolls its count back.
    const slip = await this.prisma.$transaction(async (tx) => {
      await lockAccount(tx, userId);
      // Slips older than a day no longer count, and deleting them keeps the
      // table at a day's worth per account.
      await tx.uploadSlip.deleteMany({
        where: { userId, createdAt: { lt: new Date(Date.now() - DAY_MS) } },
      });

      if (
        (await tx.uploadSlip.count({ where: { userId } })) >=
        UPLOAD_SLIPS_PER_DAY
      ) {
        throw new TooManyUploadsError(UPLOAD_SLIPS_PER_DAY);
      }

      await tx.uploadSlip.create({ data: { userId, key } });

      return this.storage.signUpload(
        key,
        UPLOAD_MAX_BYTES,
        UPLOAD_EXPIRES_IN_SECONDS,
      );
    });

    return { key, ...slip, maxBytes: UPLOAD_MAX_BYTES };
  }
}
