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
import { Upload } from '@aws-sdk/lib-storage';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { SharedEnv } from '../config/env.schema.js';

/** An object opened for reading, and the version of it being read. */
export interface OpenedObject {
  body: Readable;

  /**
   * S3's fingerprint of these exact bytes. Passed back as `ifMatch`, it makes a
   * later read fail rather than return different bytes under the same key.
   */
  etag: string;
}

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
   * @param ifMatch an `etag` from an earlier read: the object is opened only if
   * it still holds those bytes.
   * @returns the opened object, `'missing'` when there is no such object, or
   * `'changed'` when it no longer matches `ifMatch`.
   */
  async openStream(
    key: string,
    { ifMatch }: { ifMatch?: string } = {},
  ): Promise<OpenedObject | 'missing' | 'changed'> {
    try {
      const { Body, ETag } = await this.client.send(
        new GetObjectCommand({
          Bucket: this.bucket,
          Key: key,
          IfMatch: ifMatch,
        }),
      );

      // In Node the SDK's body is an IncomingMessage, which is a Readable.
      const body = Body as Readable;

      // S3 sends one on every GetObject; the SDK types every header optional.
      if (!ETag) {
        body.destroy();

        throw new Error(`S3 returned ${key} without an ETag`);
      }

      return { body, etag: ETag };
    } catch (error) {
      if (error instanceof NoSuchKey) {
        return 'missing';
      }

      if (
        error instanceof S3ServiceException &&
        error.$metadata.httpStatusCode === 412
      ) {
        return 'changed';
      }

      throw error;
    }
  }

  /**
   * Writes a stream to an object as it is produced, in parts, so an object of
   * unknown length costs a part's worth of memory rather than its whole size.
   * Replaces whatever the key held.
   *
   * @param downloadAs the file name a browser saves the object under.
   * @throws when the stream or S3 fails; the parts already sent are discarded.
   */
  async upload(
    key: string,
    body: Readable,
    { contentType, downloadAs }: { contentType: string; downloadAs: string },
  ) {
    await new Upload({
      client: this.client,
      params: {
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
        ContentDisposition: `attachment; filename="${downloadAs}"`,
      },
    }).done();
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
