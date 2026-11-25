import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../../src/app.module.js';
import { configureApp } from '../../src/configure-app.js';

const PASSWORD = 'password123';

/**
 * The API's whole `AppModule`, behind the edge `main.ts` gives it, listening on
 * a free port.
 *
 * `listen()`, not `init()`: against a server that is not already listening,
 * supertest binds and closes a port per request, and two concurrent requests
 * then race on the same server object and surface as ECONNRESET.
 */
export const startApp = async () => {
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>({
    bodyParser: false,
  });

  configureApp(app);
  await app.listen(0);

  return { app, server: app.getHttpServer() as Server };
};

/**
 * A new account, registered and logged in over HTTP the way a client does.
 *
 * @param label names the test in the email, so a leftover row says where it
 * came from.
 * @returns its access token, user id and email.
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
    email,
  };
};

/**
 * Logs an account in again: the token carries the role the account had at
 * login, so a test that promotes one needs a new token.
 */
export const logIn = async (server: Server, email: string) => {
  const { body } = await request(server)
    .post('/auth/login')
    .send({ email, password: PASSWORD })
    .expect(200);

  return body.data.accessToken as string;
};
