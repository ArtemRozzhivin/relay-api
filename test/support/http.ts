import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../../src/app.module.js';

const PASSWORD = 'password123';

/**
 * The API's whole `AppModule`, listening on a free port.
 *
 * `listen()`, not `init()`: against a server that is not already listening,
 * supertest binds and closes a port per request, and two concurrent requests
 * then race on the same server object and surface as ECONNRESET.
 */
export const startApp = async () => {
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();
  const app = moduleRef.createNestApplication();

  await app.listen(0);

  return { app, server: app.getHttpServer() as Server };
};

/**
 * A new account, registered and logged in over HTTP the way a client does.
 *
 * @param label names the test in the email, so a leftover row says where it
 * came from.
 * @returns its access token and user id.
 */
export const registerAndLogin = async (server: Server, label: string) => {
  const email = `${label}-${randomUUID()}@example.com`;

  await request(server)
    .post('/auth/register')
    .send({ email, password: PASSWORD })
    .expect(201);

  const { body } = await request(server)
    .post('/auth/login')
    .send({ email, password: PASSWORD })
    .expect(200);

  return {
    token: body.data.accessToken as string,
    userId: body.data.user.id as string,
  };
};
