import type { INestApplication } from '@nestjs/common';
import {
  DocumentBuilder,
  SwaggerModule,
  type OpenAPIObject,
} from '@nestjs/swagger';
import { z } from 'zod';
import { failed } from './openapi-schemas.js';

type Schema = NonNullable<
  NonNullable<OpenAPIObject['components']>['schemas']
>[string];

const DESCRIPTION = `
Relay runs a seller's catalog work in the background: CSV imports, product images, AI
categories and tags, and pipelines that chain them. A request is accepted at once and the work
runs after it — poll \`GET /jobs/{id}\` or \`GET /pipelines/{id}\` for how it goes.

## Signing in

Every route but registration and login takes \`Authorization: Bearer <token>\`, with one of:

- **A session**: the \`accessToken\` \`POST /auth/login\` returns. It lasts 15 minutes; renew it with
  \`POST /auth/refresh\`. For a person.
- **An API key**: \`relay_…\`, made with \`POST /api-keys\` while signed in. It lasts until revoked,
  and its secret is shown once, when it is made. For a seller's own system. An account holds
  one key at a time. A \`read\` key makes the \`GET\` requests of jobs, pipelines, uploads and
  products; a \`write\` key their \`POST\`s. A key is never accepted by \`/auth\` or \`/api-keys\`.

## Every request that starts work takes an \`Idempotency-Key\`

\`POST /jobs\` and \`POST /pipelines\` require the header. Send the same key again — after a timeout,
say — and you get the job the first request made, with \`replayed: true\`, never a second one. The
same key with a different body is \`422 IDEMPOTENCY_KEY_REUSED\`. A key may not begin with
\`pipeline:\`.

## Answers

A success is \`{ success: true, data, requestId }\`; a failure is
\`{ success: false, error: { code, message }, requestId }\`, \`error.code\` saying which. Quote the
\`requestId\` — also in the \`X-Request-Id\` header — when asking about a request.

Too many requests is \`429\` with a \`Retry-After\` in seconds. Lists are newest first and paged by
cursor: pass the \`nextCursor\` a page returns as \`?cursor=\`, until it is \`null\`.
`.trim();

/**
 * Serves the API's reference at `/docs`, and the OpenAPI document it is drawn
 * from at `/docs/openapi.json` (§6.5). Built from the schemas the routes
 * validate with and answer by, so it describes the requests they take and
 * the answers they give.
 */
export const setUpApiDocs = (app: INestApplication) => {
  const config = new DocumentBuilder()
    .setTitle('Relay API')
    .setDescription(DESCRIPTION)
    .setVersion('1')
    .addBearerAuth(
      {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        description: 'A session: the accessToken POST /auth/login returns',
      },
      'session',
    )
    .addBearerAuth(
      {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'relay_…',
        description: 'An API key, made with POST /api-keys',
      },
      'apiKey',
    )
    .build();

  const document = withErrorResponses(
    SwaggerModule.createDocument(app, config),
  );

  SwaggerModule.setup('docs', app, document, {
    jsonDocumentUrl: 'docs/openapi.json',
    customSiteTitle: 'Relay API',
  });
};

// Every route can fail, and every failure has one shape: documented once, as
// each operation's default response, rather than per route and status.
const withErrorResponses = (document: OpenAPIObject) => {
  const { $schema: _dialect, ...errorEnvelope } = z.toJSONSchema(failed, {
    target: 'openapi-3.0',
  });

  document.components = {
    ...document.components,
    schemas: {
      ...document.components?.schemas,
      ErrorEnvelope: errorEnvelope as Schema,
    },
  };

  for (const path of Object.values(document.paths)) {
    for (const operation of [
      path.get,
      path.post,
      path.put,
      path.patch,
      path.delete,
    ]) {
      if (operation) {
        operation.responses = {
          ...operation.responses,
          default: {
            description: 'A failure; `error.code` says which',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ErrorEnvelope' },
              },
            },
          },
        };
      }
    }
  }

  return document;
};
