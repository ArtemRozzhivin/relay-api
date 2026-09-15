import { Test } from '@nestjs/testing';
import { UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthService } from './auth.service.js';
import { PasswordService } from './password.service.js';
import { TokenService } from './token.service.js';
import { PrismaService } from '../prisma/prisma.service.js';

const user = {
  id: 'user-1',
  email: 'alice@example.com',
  role: 'USER' as const,
  passwordHash: 'hashed',
};

describe('AuthService', () => {
  let service: AuthService;
  let prisma: { user: { findUnique: ReturnType<typeof vi.fn> } };
  let passwords: { verify: ReturnType<typeof vi.fn>; hash: ReturnType<typeof vi.fn> };
  let tokens: { issueRefreshToken: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    prisma = { user: { findUnique: vi.fn() } };
    passwords = { verify: vi.fn(), hash: vi.fn() };
    tokens = { issueRefreshToken: vi.fn().mockResolvedValue('refresh-token') };

    const moduleRef = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: PrismaService, useValue: prisma },
        { provide: PasswordService, useValue: passwords },
        { provide: TokenService, useValue: tokens },
        { provide: JwtService, useValue: { signAsync: vi.fn().mockResolvedValue('access-token') } },
      ],
    }).compile();

    service = moduleRef.get(AuthService);
  });

  it('rejects an unknown email', async () => {
    prisma.user.findUnique.mockResolvedValue(null);

    await expect(
      service.signIn({ email: 'nobody@example.com', password: 'password123' }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects a wrong password', async () => {
    prisma.user.findUnique.mockResolvedValue(user);
    passwords.verify.mockResolvedValue(false);

    await expect(
      service.signIn({ email: user.email, password: 'wrong-password' }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('returns tokens and never returns the password hash', async () => {
    prisma.user.findUnique.mockResolvedValue(user);
    passwords.verify.mockResolvedValue(true);

    const result = await service.signIn({
      email: user.email,
      password: 'password123',
    });

    expect(result.accessToken).toBe('access-token');
    expect(result.refreshToken).toBe('refresh-token');
    expect(result.user).not.toHaveProperty('passwordHash');
  });
});
