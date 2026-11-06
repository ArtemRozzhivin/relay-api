import { Injectable } from '@nestjs/common';
import { StorageService } from '../storage/storage.service.js';
import { mintUploadKey } from '../storage/object-keys.js';

// Far beyond the 20 000-row catalog PB is built for, and small enough that a
// wrong file — a video, a database dump — is refused by S3 before it is stored.
export const UPLOAD_MAX_BYTES = 50 * 1024 * 1024;

// Long enough to pick a file and send it on a slow connection; short enough
// that a leaked link is useless soon after.
const UPLOAD_EXPIRES_IN_SECONDS = 300;

@Injectable()
export class UploadsService {
  constructor(private readonly storage: StorageService) {}

  /**
   * Mints a key under the caller's own prefix and signs an upload to it.
   *
   * The caller never chooses the key, so it can neither overwrite another
   * tenant's file nor name a path an import would later trust.
   */
  async createUpload(userId: string) {
    const key = mintUploadKey(userId);
    const slip = await this.storage.signUpload(
      key,
      UPLOAD_MAX_BYTES,
      UPLOAD_EXPIRES_IN_SECONDS,
    );

    return { key, ...slip, maxBytes: UPLOAD_MAX_BYTES };
  }
}
