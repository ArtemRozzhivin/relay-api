import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import http, { type IncomingMessage } from 'node:http';
import https from 'node:https';
import { isIP, type LookupFunction } from 'node:net';
import { isPublicAddress } from './public-address.js';

/**
 * Why a download produced no file. `permanent` says whether asking again
 * could change the answer: a 404 will not, a timeout might.
 */
export class DownloadFailedError extends Error {
  constructor(
    message: string,
    readonly permanent: boolean,
  ) {
    super(message);
    this.name = 'DownloadFailedError';
  }
}

export interface DownloadLimits {
  /** For the whole download: every lookup, connection, redirect and byte. */
  timeoutMs: number;
  maxBytes: number;
  maxRedirects: number;

  /** Whether the response's `Content-Type` is one the caller can use. */
  accepts: (contentType: string) => boolean;
}

export interface Downloaded {
  body: Buffer;
  contentType: string;
}

export interface GuardOptions {
  /** How a host name becomes addresses. Replaced by tests only. */
  lookup?: typeof dnsLookup;

  /**
   * Which resolved addresses may be connected to. Replaced only by tests that
   * serve from 127.0.0.1, which the real policy refuses.
   */
  isAllowed?: (address: string) => boolean;

  /** Which ports, `''` meaning the scheme's own. Replaced by tests only. */
  ports?: readonly string[];
}

// Never 304: a request without validators cannot be answered with one.
const REDIRECTS = new Set([301, 302, 303, 307, 308]);

// Asking again can change these; every other 4xx is the same answer however
// often it is asked.
const TRANSIENT_STATUSES = new Set([408, 429]);

// One answer for a name that resolves privately and a name that does not
// exist: told apart, they would let a seller list which internal names exist
// by asking for each. Without the address either: naming what an internal host
// resolves to maps the network for whoever asks.
const notPublic = (hostname: string) =>
  new DownloadFailedError(
    `${hostname} does not resolve to a public address`,
    true,
  );

// A port is a choice of service. Allowing any would let a seller's URL probe
// whatever else a public host runs.
const WEB_PORTS = ['', '80', '443'];

/**
 * Downloads a URL a user supplied, refusing anything that would make this
 * server reach somewhere the user could not reach themselves: a private
 * address, the cloud metadata service, a port other than 80 or 443, or a
 * redirect to any of those.
 */
export class GuardedDownloader {
  private readonly resolve: typeof dnsLookup;
  private readonly isAllowed: (address: string) => boolean;
  private readonly ports: ReadonlySet<string>;

  constructor({
    lookup = dnsLookup,
    isAllowed = isPublicAddress,
    ports = WEB_PORTS,
  }: GuardOptions = {}) {
    this.resolve = lookup;
    this.isAllowed = isAllowed;
    this.ports = new Set(ports);
  }

  /**
   * @throws DownloadFailedError for every way the download can fail, marked
   * permanent or not.
   */
  async download(raw: string, limits: DownloadLimits): Promise<Downloaded> {
    const signal = AbortSignal.timeout(limits.timeoutMs);
    let url = this.check(raw);

    try {
      for (let hop = 0; ; hop += 1) {
        const response = await this.send(url, signal);
        const status = response.statusCode ?? 0;

        if (REDIRECTS.has(status)) {
          response.destroy();

          const location = response.headers.location;

          if (!location) {
            throw new DownloadFailedError(`${status} without a Location`, true);
          }

          if (hop === limits.maxRedirects) {
            throw new DownloadFailedError(
              `More than ${limits.maxRedirects} redirects`,
              true,
            );
          }

          // Checked like the first URL: a redirect to 169.254.169.254 is the
          // classic way past a guard that looks only at the URL it was given.
          url = this.check(new URL(location, url).href);
          continue;
        }

        return await this.read(response, status, limits);
      }
    } catch (error) {
      throw this.classify(error, signal, url);
    }
  }

  private check(raw: string) {
    let url: URL;

    try {
      url = new URL(raw);
    } catch {
      throw new DownloadFailedError('Not a URL', true);
    }

    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new DownloadFailedError(
        `${url.protocol} is not http or https`,
        true,
      );
    }

    if (url.username || url.password) {
      throw new DownloadFailedError('A URL with credentials in it', true);
    }

    if (!this.ports.has(url.port)) {
      throw new DownloadFailedError(`Port ${url.port} is not 80 or 443`, true);
    }

    // An address written as the host is never looked up, so the lookup below
    // never sees it; it is checked here. The URL parser has already turned
    // 2130706433 and 0x7f.1 into 127.0.0.1.
    const host = url.hostname.replace(/^\[|\]$/g, '');

    if (isIP(host) && !this.isAllowed(host)) {
      throw new DownloadFailedError(`${host} is not a public address`, true);
    }

    return url;
  }

  // The check runs inside the connection's own lookup, on the addresses it
  // will connect to. Checking a name first and connecting after would resolve
  // it twice, and a name can answer public to the check and private to the
  // connection (DNS rebinding).
  private readonly guardedLookup: LookupFunction = (
    hostname,
    options,
    done,
  ) => {
    this.resolve(hostname, { ...options, all: true }, (error, addresses) => {
      if (error) {
        done(error, '', 0);

        return;
      }

      const found = addresses as LookupAddress[];
      // Every address, not the first: a name that answers with one public and
      // one private address leaves the choice to whoever connects.
      const refused = found.find(({ address }) => !this.isAllowed(address));

      if (refused || found.length === 0) {
        done(notPublic(hostname), '', 0);

        return;
      }

      if (options.all) {
        done(null, found);
      } else {
        done(null, found[0]!.address, found[0]!.family);
      }
    });
  };

  private send(url: URL, signal: AbortSignal) {
    return new Promise<IncomingMessage>((resolve, reject) => {
      const client = url.protocol === 'https:' ? https : http;
      const request = client.request(
        url,
        {
          // A pooled socket would skip the lookup, and with it the check.
          agent: false,
          lookup: this.guardedLookup,
          signal,
          headers: {
            // The size cap counts the bytes received, so they must be the
            // bytes of the file and not of a compressed stream of it.
            'accept-encoding': 'identity',
            'user-agent':
              'Relay/1.0 (+https://github.com/ArtemRozzhivin/relay-api)',
          },
        },
        resolve,
      );

      request.on('error', reject);
      request.end();
    });
  }

  private async read(
    response: IncomingMessage,
    status: number,
    limits: DownloadLimits,
  ): Promise<Downloaded> {
    if (status !== 200) {
      response.destroy();

      const transient = status >= 500 || TRANSIENT_STATUSES.has(status);

      throw new DownloadFailedError(
        `The server answered ${status}`,
        !transient,
      );
    }

    const contentType = (response.headers['content-type'] ?? '')
      .split(';')[0]!
      .trim()
      .toLowerCase();

    if (!limits.accepts(contentType)) {
      response.destroy();

      throw new DownloadFailedError(
        `${contentType || 'No content type'} is not an accepted type`,
        true,
      );
    }

    const declared = Number(response.headers['content-length']);
    const tooLarge = () =>
      new DownloadFailedError(`Larger than ${limits.maxBytes} bytes`, true);

    if (declared > limits.maxBytes) {
      response.destroy();

      throw tooLarge();
    }

    // Counted as it arrives as well: a length can be absent, or a lie.
    const chunks: Buffer[] = [];
    let size = 0;

    for await (const chunk of response as AsyncIterable<Buffer>) {
      size += chunk.length;

      if (size > limits.maxBytes) {
        response.destroy();

        throw tooLarge();
      }

      chunks.push(chunk);
    }

    return { body: Buffer.concat(chunks), contentType };
  }

  private classify(error: unknown, signal: AbortSignal, url: URL) {
    if (error instanceof DownloadFailedError) {
      return error;
    }

    if (signal.aborted) {
      return new DownloadFailedError('Timed out', false);
    }

    const code = (error as NodeJS.ErrnoException).code;

    // A name that does not exist will not exist on the next attempt either;
    // EAI_AGAIN, a resolver that did not answer, might.
    if (code === 'ENOTFOUND') {
      return notPublic(url.hostname);
    }

    // A certificate that does not verify is a fact about the server, not a
    // network blip.
    if (code && /^ERR_TLS|CERT|SIGNATURE/.test(code)) {
      return new DownloadFailedError(`TLS refused: ${code}`, true);
    }

    return new DownloadFailedError(
      `Could not download: ${error instanceof Error ? error.message : String(error)}`,
      false,
    );
  }
}
