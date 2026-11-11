import {
  DeleteObjectsCommand,
  ListObjectsV2Command,
  type S3Client,
} from '@aws-sdk/client-s3';
import { productImagesPrefix } from '../../src/storage/object-keys.js';

/**
 * Deletes every image the worker made for a test's account. Nothing else ever
 * would: the bucket's lifecycle rules spare `products/`, because a seller's
 * images must not expire (§13.4).
 */
export const deleteProductImages = async (
  s3: S3Client,
  bucket: string,
  userId: string,
) => {
  let token: string | undefined;

  do {
    const page = await s3.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: productImagesPrefix(userId),
        ContinuationToken: token,
      }),
    );
    const objects = (page.Contents ?? []).flatMap(({ Key }) =>
      Key ? [{ Key }] : [],
    );

    // A listed page holds at most 1 000 keys, which is what one delete takes.
    if (objects.length > 0) {
      await s3.send(
        new DeleteObjectsCommand({
          Bucket: bucket,
          Delete: { Objects: objects, Quiet: true },
        }),
      );
    }

    token = page.NextContinuationToken;
  } while (token);
};
