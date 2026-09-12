import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { createHash, randomUUID } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service.js';
import type { ApiEnv } from '../config/env.schema.js';

interface RefreshPayload {
  sub: string;
  jti: string;
  exp: number;
}

@Injectable()
export class TokenService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService<ApiEnv, true>,
  ) {}

  private fingerprint(token: string) {
    return createHash('sha256').update(token).digest('hex');
  }

  async issueRefreshToken(userId: string) {
    const token = await this.jwt.signAsync(
      { sub: userId, jti: randomUUID() },
      {
        secret: this.config.get('JWT_REFRESH_SECRET', { infer: true }),
        expiresIn: this.config.get('REFRESH_TOKEN_TTL', { infer: true }),
      },
    );

    const { exp } = this.jwt.decode<RefreshPayload>(token);

    await this.prisma.refreshToken.create({
      data: {
        userId,
        tokenHash: this.fingerprint(token),
        expiresAt: new Date(exp * 1000),
      },
    });

    return token;
  }

  async rotateRefreshToken(presented: string) {
    let payload: RefreshPayload;

    try {
      payload = await this.jwt.verifyAsync<RefreshPayload>(presented, {
        secret: this.config.get('JWT_REFRESH_SECRET', { infer: true }),
      });
    } catch {
      throw new UnauthorizedException('Invalid refresh token');
    }

    const { count } = await this.prisma.refreshToken.updateMany({
      where: {
        tokenHash: this.fingerprint(presented),
        revokedAt: null,
        expiresAt: { gt: new Date() },
      },
      data: { revokedAt: new Date() },
    });

    if (count === 0) {
      throw new UnauthorizedException('Invalid refresh token');
    }

    return {
      userId: payload.sub,
      refreshToken: await this.issueRefreshToken(payload.sub),
    };
  }

  async revokeAllForUser(userId: string) {
    await this.prisma.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }
}
