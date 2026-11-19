import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { StorageService } from '../storage/storage.service.js';
import {
  PRODUCT_IMAGES_ROOT,
  imageSourceHash,
  readProductImageKey,
} from '../storage/object-keys.js';
import { describeError } from '../common/errors/describe-error.js';
import { nonOverlapping } from '../common/scheduling/non-overlapping.js';

// A re-render rewrites every file in its folder, so a folder nothing has
// written to for a day is one no job is making.
export const IMAGE_FOLDER_IDLE_MS = 24 * 60 * 60 * 1000;

// A replaced image goes within a quarter of a day of falling idle, and listing
// the bucket four times a day costs nothing worth counting.
const SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** The sizes made from one source URL, as the listing found them. */
type Folder = NonNullable<ReturnType<typeof readProductImageKey>> & {
  keys: string[];
  newest: number;
};

/**
 * Deletes the image folders of URLs a product no longer has (§6.3c). An image
 * lives under the hash of the URL it was made from, so a replaced URL leaves
 * its folder behind, and nothing else deletes it: `products/` never expires
 * (§13.4).
 *
 * A folder goes only when it is neither the product's current URL's nor the
 * one its image was made from, **and** nothing in it has been written for
 * {@link IMAGE_FOLDER_IDLE_MS}. Deleting the old folder as the new image is
 * recorded would race a seller switching back to the old URL while a slow job
 * makes it again: the delete would take the files the row then points at.
 */
@Injectable()
export class ImageFolderSweeper
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(ImageFolderSweeper.name);
  private timer?: NodeJS.Timeout;

  private readonly sweepOnce = nonOverlapping(
    () => this.sweep(),
    (error) =>
      this.logger.error(`Image folder sweep failed: ${describeError(error)}`),
  );

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
  ) {}

  onApplicationBootstrap() {
    this.timer = setInterval(() => void this.sweepOnce(), SWEEP_INTERVAL_MS);
  }

  onModuleDestroy() {
    clearInterval(this.timer);
  }

  /**
   * Lists every image folder under `prefix` and deletes the ones no product
   * uses.
   *
   * @param prefix narrows the sweep to one account's images; every account's
   * by default.
   * @param now the time a folder's age is measured against.
   * @returns how many folders were deleted.
   */
  async sweep({ prefix = PRODUCT_IMAGES_ROOT, now = Date.now() } = {}) {
    let deleted = 0;
    // A page can end partway through a folder, so the folder being read is
    // judged only once a key of another one, or the end, shows it is whole.
    let open: Folder | undefined;

    for await (const page of this.storage.listPages(prefix)) {
      const whole: Folder[] = [];

      for (const object of page) {
        const key = readProductImageKey(object.key);

        // Not a key the image handler writes, so not this sweep's to judge.
        if (!key) {
          continue;
        }

        if (open?.folder !== key.folder) {
          if (open) {
            whole.push(open);
          }

          open = { ...key, keys: [], newest: 0 };
        }

        open.keys.push(object.key);
        open.newest = Math.max(open.newest, object.lastModified.getTime());
      }

      deleted += await this.deleteUnused(whole, now);
    }

    if (open) {
      deleted += await this.deleteUnused([open], now);
    }

    if (deleted > 0) {
      this.logger.log(`Image folder sweep deleted ${deleted} folder(s)`);
    }

    return deleted;
  }

  private async deleteUnused(folders: Folder[], now: number) {
    const idle = folders.filter(
      (folder) => now - folder.newest >= IMAGE_FOLDER_IDLE_MS,
    );

    if (idle.length === 0) {
      return 0;
    }

    // Read after the listing, so a URL changed while it ran is seen. What is
    // left: a URL switched back after this read, whose job then downloads,
    // renders and writes the folder before the delete below is sent.
    const products = await this.prisma.product.findMany({
      where: { id: { in: [...new Set(idle.map((f) => f.productId))] } },
      select: { id: true, userId: true, imageUrl: true, imageSourceUrl: true },
    });

    // The current URL's folder, which a job may be making now, and the one
    // the image was made from, which the row points at. A product that no
    // longer exists uses none.
    const inUse = new Map(
      products.map((product) => [
        `${product.userId}/${product.id}`,
        new Set(
          [product.imageUrl, product.imageSourceUrl].flatMap((url) =>
            url === null ? [] : [imageSourceHash(url)],
          ),
        ),
      ]),
    );

    const unused = idle.filter(
      (folder) =>
        !inUse
          .get(`${folder.userId}/${folder.productId}`)
          ?.has(folder.sourceHash),
    );

    await this.storage.deleteObjects(unused.flatMap((folder) => folder.keys));

    return unused.length;
  }
}
