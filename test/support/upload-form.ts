import type { UploadSlip } from '../../src/storage/storage.service.js';

/**
 * Sends a file the way a browser does with a presigned POST: every signed
 * field, then the file, last — S3 ignores anything after it. `override`
 * replaces signed fields, for the cases that prove S3 refuses a changed one.
 */
export const postUploadForm = (
  slip: Pick<UploadSlip, 'url' | 'fields'>,
  body: string,
  override: Record<string, string> = {},
) => {
  const form = new FormData();

  for (const [name, value] of Object.entries({
    ...slip.fields,
    ...override,
  })) {
    form.append(name, value);
  }

  form.append('file', new Blob([body], { type: 'text/csv' }));

  return fetch(slip.url, { method: 'POST', body: form });
};
