import type { JobStatus } from '../../generated/prisma/enums.js';

/**
 * A job not yet finished. One list, because three places must agree on it:
 * the account caps count these, the transitions may still move them, and the
 * stranded-job sweep checks them. A status left out of a copy would quietly
 * drop out of a cap, or out of the sweep.
 */
export const UNFINISHED_STATUSES: JobStatus[] = ['QUEUED', 'RUNNING'];
