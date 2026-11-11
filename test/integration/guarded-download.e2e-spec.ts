import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import type { LookupAddress } from 'node:dns';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Readable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { StorageModule } from '../../src/storage/storage.module.js';
import { StorageService } from '../../src/storage/storage.service.js';
import { workerEnvSchema } from '../../src/config/env.schema.js';
import {
  DownloadFailedError,
  GuardedDownloader,
  type DownloadLimits,
} from '../../src/outbound/guarded-download.js';

const IMAGE = Buffer.alloc(100, 7);

const limits: DownloadLimits = {
  timeoutMs: 2000,
  maxBytes: 1000,
  maxRedirects: 3,
  accepts: (contentType) => contentType === 'image/png',
};

// A server that misbehaves in each of the ways a seller's URL can.
const routes: Record<
  string,
  (response: import('node:http').ServerResponse) => void
> = {
  '/image.png': (response) => {
    response.writeHead(200, { 'content-type': 'image/png; charset=binary' });
    response.end(IMAGE);
  },
  '/redirect': (response) => {
    response.writeHead(302, { location: '/image.png' });
    response.end();
  },
  '/to-metadata': (response) => {
    response.writeHead(302, {
      location: 'http://169.254.169.254/latest/meta-data/',
    });
    response.end();
  },
  '/loop': (response) => {
    response.writeHead(302, { location: '/loop' });
    response.end();
  },
  '/declared-too-large': (response) => {
    response.writeHead(200, {
      'content-type': 'image/png',
      'content-length': '5000',
    });
    response.end(Buffer.alloc(5000));
  },
  // No length, so only counting the bytes as they arrive can stop it.
  '/streams-too-much': (response) => {
    response.writeHead(200, { 'content-type': 'image/png' });

    for (let i = 0; i < 10; i += 1) {
      response.write(Buffer.alloc(500));
    }

    response.end();
  },
  '/never-finishes': (response) => {
    response.writeHead(200, { 'content-type': 'image/png' });
    response.write(Buffer.alloc(10));
  },
  '/page.html': (response) => {
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end('<html></html>');
  },
};

for (const status of [404, 410, 403, 408, 429, 500, 503]) {
  routes[`/status/${status}`] = (response) => {
    response.writeHead(status);
    response.end();
  };
}

describe('the guarded download', () => {
  let server: Server;
  let base: string;

  // Allowed to reach this test's own server and nothing else: the real rule
  // refuses 127.0.0.1, and its random port. The scheme's own port stays
  // allowed, so a redirect away from the server meets the address rule.
  const local = () =>
    new GuardedDownloader({
      isAllowed: (address) => address === '127.0.0.1',
      ports: ['', String((server.address() as AddressInfo).port)],
    });

  const failure = (promise: Promise<unknown>) =>
    promise.then(
      () => {
        throw new Error('expected the download to fail');
      },
      (error: unknown) => {
        expect(error).toBeInstanceOf(DownloadFailedError);

        return error as DownloadFailedError;
      },
    );

  beforeAll(async () => {
    server = createServer((request, response) => {
      const route = routes[request.url ?? ''];

      if (route) {
        route(response);
      } else {
        response.writeHead(404);
        response.end();
      }
    });

    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });

  it('returns the bytes and the bare content type', async () => {
    expect(await local().download(`${base}/image.png`, limits)).toEqual({
      body: IMAGE,
      contentType: 'image/png',
    });
  });

  it('follows a redirect', async () => {
    const { body } = await local().download(`${base}/redirect`, limits);

    expect(body).toEqual(IMAGE);
  });

  it.each([
    [
      'a redirect to the metadata service',
      '/to-metadata',
      /169\.254\.169\.254 is not a public address/,
    ],
    ['a redirect loop', '/loop', /More than 3 redirects/],
    [
      'a declared length over the cap',
      '/declared-too-large',
      /Larger than 1000 bytes/,
    ],
    [
      'a stream that outgrows the cap',
      '/streams-too-much',
      /Larger than 1000 bytes/,
    ],
    [
      'a type the caller does not accept',
      '/page.html',
      /text\/html is not an accepted type/,
    ],
    ['a 404', '/status/404', /answered 404/],
    ['a 410', '/status/410', /answered 410/],
    ['a 403', '/status/403', /answered 403/],
  ])('fails for good on %s', async (_label, path, reason) => {
    const error = await failure(local().download(`${base}${path}`, limits));

    expect(error.message).toMatch(reason);
    expect(error.permanent).toBe(true);
  });

  it.each([
    ['a 408', '/status/408'],
    ['a 429', '/status/429'],
    ['a 500', '/status/500'],
    ['a 503', '/status/503'],
  ])(
    'fails for now on %s, which asking again can change',
    async (_label, path) => {
      const error = await failure(local().download(`${base}${path}`, limits));

      expect(error.permanent).toBe(false);
    },
  );

  it('times out a body that never finishes, as something worth retrying', async () => {
    const error = await failure(
      local().download(`${base}/never-finishes`, { ...limits, timeoutMs: 300 }),
    );

    expect(error).toMatchObject({ message: 'Timed out', permanent: false });
  });

  // A16, against the real rule: nothing replaced but, for one case, the
  // resolver — to make a public-looking name answer with a private address.
  describe('A16 · a URL reaches nothing private', () => {
    const guard = new GuardedDownloader();

    it.each([
      'http://localhost/',
      'http://169.254.169.254/latest/meta-data/',
      'http://[::1]/',
      'http://[::ffff:127.0.0.1]/',
      'http://2130706433/',
      'http://0x7f.1/',
      'http://10.0.0.1/',
      'http://100.64.0.1/',
    ])('refuses %s', async (url) => {
      const error = await failure(guard.download(url, limits));

      expect(error.message).toMatch(/not .*a public address/);
      expect(error.permanent).toBe(true);
    });

    it.each([
      ['a public name that resolves to a private address', ['10.0.0.5']],
      [
        'a name with one public and one private address',
        ['52.219.170.1', '127.0.0.1'],
      ],
    ])('refuses %s', async (_label, addresses) => {
      const rebinding = new GuardedDownloader({
        lookup: ((
          _hostname: string,
          _options: object,
          done: (error: null, found: LookupAddress[]) => void,
        ) =>
          done(
            null,
            addresses.map((address) => ({ address, family: 4 })),
          )) as unknown as typeof import('node:dns').lookup,
      });

      const error = await failure(
        rebinding.download('http://images.example.com/a.png', limits),
      );

      expect(error.message).toBe(
        'images.example.com does not resolve to a public address',
      );
    });

    // Told apart, the two answers would let a seller list which internal names
    // exist, one URL at a time.
    it('answers a name that does not exist as it answers a private one', async () => {
      const url = 'http://db.internal.example.com/a.png';
      const resolvingTo = (
        answer: (hostname: string) => [Error | null, LookupAddress[]],
      ) =>
        ((
          hostname: string,
          _options: object,
          done: (error: Error | null, found: LookupAddress[]) => void,
        ) =>
          done(
            ...answer(hostname),
          )) as unknown as typeof import('node:dns').lookup;

      const missing = await failure(
        new GuardedDownloader({
          // As getaddrinfo reports a name nobody has registered.
          lookup: resolvingTo((hostname) => [
            Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), {
              code: 'ENOTFOUND',
              hostname,
            }),
            [],
          ]),
        }).download(url, limits),
      );
      const internal = await failure(
        new GuardedDownloader({
          lookup: resolvingTo(() => [
            null,
            [{ address: '10.0.0.5', family: 4 }],
          ]),
        }).download(url, limits),
      );

      expect(missing.message).toBe(internal.message);
      expect(missing.permanent).toBe(true);
    });

    it.each([
      ['ftp://example.com/a.png', /ftp: is not http or https/],
      ['file:///etc/passwd', /file: is not http or https/],
      ['http://user:secret@example.com/a.png', /credentials/],
      ['http://example.com:8080/a.png', /Port 8080/],
      ['not a url', /Not a URL/],
    ])('refuses %s before connecting anywhere', async (url, reason) => {
      const error = await failure(guard.download(url, limits));

      expect(error.message).toMatch(reason);
      expect(error.permanent).toBe(true);
    });
  });

  // The whole real path once: public DNS, TLS, and the lookup that checks the
  // addresses it connects to.
  it('downloads from a real public host under the real rule', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          cache: true,
          envFilePath: ['.env'],
          validationSchema: workerEnvSchema,
        }),
        StorageModule,
      ],
    }).compile();

    await moduleRef.init();

    const storage = moduleRef.get(StorageService);
    const key = `fixtures/${randomUUID()}.png`;

    await storage.upload(key, Readable.from([IMAGE]), {
      contentType: 'image/png',
      downloadAs: 'fixture.png',
    });

    const { url } = await storage.signDownload(key, 60);

    expect(await new GuardedDownloader().download(url, limits)).toEqual({
      body: IMAGE,
      contentType: 'image/png',
    });

    await moduleRef.close();
  });
});
