import {
  Injectable,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Readable } from 'node:stream';
import {
  GetObjectCommand,
  HeadObjectCommand,
  NoSuchKey,
  S3Client,
  S3ServiceException,
} from '@aws-sdk/client-s3';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { SharedEnv } from '../config/env.schema.js';

/** A signed permission to upload one object, as an HTML form would (presigned POST). */
export interface UploadSlip {
  url: string;
  /** Every one of these goes in the form, before the file, which comes last. */
  fields: Record<string, string>;
  expiresAt: Date;
}

@Injectable()
export class StorageService implements OnModuleInit, OnModuleDestroy {
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(config: ConfigService<SharedEnv, true>) {
    const endpoint = config.get('S3_ENDPOINT', { infer: true });

    this.bucket = config.get('S3_BUCKET', { infer: true });
    this.client = new S3Client({
      region: config.get('AWS_REGION', { infer: true }),
      // Only for an S3-compatible emulator, which serves a bucket as a path
      // rather than as a subdomain the way AWS does.
      ...(endpoint === undefined ? {} : { endpoint, forcePathStyle: true }),
    });
  }

  // Credentials come from the SDK's own chain — the AWS_ACCESS_KEY_ID pair in
  // the environment here, a role on a host that has one — so they are resolved
  // at boot: a missing key fails the deploy, not the first upload (§11).
  async onModuleInit() {
    await this.client.config.credentials();
  }

  onModuleDestroy() {
    this.client.destroy();
  }

  /**
   * Signs a presigned POST for exactly one object.
   *
   * S3 enforces everything the policy names — this key, a size between 1 byte
   * and `maxBytes`, and the expiry — so whatever a client sends, it cannot
   * upload under another key or upload more than it was allowed. That size
   * check is why this is a POST: a presigned PUT carries no size limit.
   */
  async signUpload(
    key: string,
    maxBytes: number,
    expiresInSeconds: number,
  ): Promise<UploadSlip> {
    // Taken before signing, so the time a client is told is never later than
    // the one S3 will hold it to.
    const expiresAt = new Date(Date.now() + expiresInSeconds * 1000);

    const { url, fields } = await createPresignedPost(this.client, {
      Bucket: this.bucket,
      Key: key,
      Conditions: [['content-length-range', 1, maxBytes]],
      Expires: expiresInSeconds,
    });

    return { url, fields, expiresAt };
  }

  /**
   * Whether an object exists. Only a 404 answers `false`: a permissions or
   * network failure is not an absent file, and must not be reported as one.
   */
  async exists(key: string) {
    try {
      await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
      );

      return true;
    } catch (error) {
      if (
        error instanceof S3ServiceException &&
        error.$metadata.httpStatusCode === 404
      ) {
        return false;
      }

      throw error;
    }
  }

  /**
   * Opens an object for reading, as a stream: nothing is buffered beyond what
   * the reader has asked for, so a file of any size costs the same memory.
   *
   * @returns the stream, or `null` when there is no such object.
   */
  async openStream(key: string): Promise<Readable | null> {
    try {
      const { Body } = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      );

      // In Node the SDK's body is an IncomingMessage, which is a Readable.
      return Body as Readable;
    } catch (error) {
      if (error instanceof NoSuchKey) {
        return null;
      }

      throw error;
    }
  }

  /** A link that downloads one object until it expires. */
  signDownload(key: string, expiresInSeconds: number) {
    return getSignedUrl(
      this.client,
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      { expiresIn: expiresInSeconds },
    );
  }
}
