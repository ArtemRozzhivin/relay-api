import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { PasswordService } from './password.service.js';
import { JwtService } from '@nestjs/jwt';
import { TokenService } from './token.service.js';
import { Prisma } from '../generated/prisma/client.js';
import { LoginInput, RegisterInput } from './auth.schema.js';
import {
  EmailAlreadyRegisteredError,
  InvalidCredentialsError,
} from '../common/errors/app-error.js';

@Injectable()
export class AuthService {
  constructor(
    private readonly dbService: PrismaService,
    private readonly passwordService: PasswordService,
    private readonly jwtService: JwtService,
    private readonly tokenService: TokenService,
  ) {}

  async signIn({ email, password }: LoginInput) {
    const user = await this.dbService.user.findUnique({ where: { email } });

    if (!user) {
      throw new InvalidCredentialsError();
    }

    const verify = await this.passwordService.verify(
      password,
      user.passwordHash,
    );

    if (!verify) {
      throw new InvalidCredentialsError();
    }

    const payload = { sub: user.id, email: user.email, role: user.role };

    const accessToken = await this.jwtService.signAsync(payload);
    const refreshToken = await this.tokenService.issueRefreshToken(user.id);

    const { passwordHash: _passwordHash, ...rest } = user;

    return {
      user: rest,
      accessToken,
      refreshToken,
    };
  }

  async register({ email, password }: RegisterInput) {
    const passwordHash = await this.passwordService.hash(password);

    try {
      const user = await this.dbService.user.create({
        data: {
          email,
          passwordHash,
        },
        omit: {
          passwordHash: true,
        },
      });

      return user;
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new EmailAlreadyRegisteredError();
      }
      throw error;
    }
  }

  async refresh(rawRefreshToken: string) {
    const result = await this.tokenService.rotateRefreshToken(rawRefreshToken);

    const user = await this.dbService.user.findUnique({
      where: { id: result.userId },
      omit: { passwordHash: true },
    });

    if (!user) {
      throw new InvalidCredentialsError();
    }

    const payload = { sub: user.id, email: user.email, role: user.role };
    const accessToken = await this.jwtService.signAsync(payload);

    return {
      accessToken,
      refreshToken: result.refreshToken,
    };
  }

  async logout(userId: string) {
    await this.tokenService.revokeAllForUser(userId);
  }
}
