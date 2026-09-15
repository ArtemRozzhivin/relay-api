import { Test } from '@nestjs/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';

describe('AuthController', () => {
  let controller: AuthController;
  const authService = {
    signIn: vi.fn(),
    register: vi.fn(),
    refresh: vi.fn(),
    logout: vi.fn(),
  };

  beforeEach(async () => {
    vi.clearAllMocks();

    const moduleRef = await Test.createTestingModule({
      controllers: [AuthController],
      providers: [{ provide: AuthService, useValue: authService }],
    }).compile();

    controller = moduleRef.get(AuthController);
  });

  it('passes login credentials through to the service', async () => {
    const body = { email: 'alice@example.com', password: 'password123' };
    authService.signIn.mockResolvedValue({ accessToken: 'a' });

    await controller.login(body);

    expect(authService.signIn).toHaveBeenCalledWith(body);
  });

  it('logs out the authenticated user, not a caller-supplied id', async () => {
    await controller.logout({
      id: 'user-1',
      email: 'alice@example.com',
      role: 'USER',
    });

    expect(authService.logout).toHaveBeenCalledWith('user-1');
  });
});
