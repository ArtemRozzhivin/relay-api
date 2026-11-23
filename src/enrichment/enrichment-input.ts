import { createHash } from 'node:crypto';

// Raised when the instructions or the categories change, so that every
// product's enrichment reads as out of date and the next run asks again.
const ENRICHMENT_VERSION = 1;

/**
 * Names what a product's enrichment is made from: its name, its description
 * and the version of the instructions. Stored with the enrichment, so a
 * product whose text has changed since reads as not enriched yet.
 */
export const hashEnrichmentInput = ({
  name,
  description,
}: {
  name: string;
  description: string | null;
}) =>
  createHash('sha256')
    .update(JSON.stringify([ENRICHMENT_VERSION, name, description]))
    .digest('hex');
