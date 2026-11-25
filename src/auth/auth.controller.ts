import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { hours, minutes } from '@nestjs/throttler';
import { AuthService } from './auth.service.js';
import {
  loginSchema,
  registerSchema,
  refreshSchema,
  type RegisterInput,
  type LoginInput,
  type RefreshInput,
} from './auth.schema.js';
import { Public } from './decorators/public.decorator.js';
import { CurrentUser } from './decorators/current-user.decorator.js';
import { type AuthenticatedUser } from './auth.types.js';
import { RateLimit } from '../common/rate-limit/rate-limit.js';
import {
  ApiOperation,
  ApiResponse,
  ApiTags,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { HttpStatus } from '@nestjs/common';
import { ApiData } from '../docs/openapi-schemas.js';
import { signedInView, tokensView, userView } from './auth.responses.js';

@ApiTags('Sessions')
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  // Each guess costs an Argon2 hash, and a person mistypes a few times, not ten.
  @RateLimit(10, minutes(1))
  @Public()
  @ApiOperation({ summary: 'Sign in, for a session' })
  @ApiData(HttpStatus.OK, signedInView, 'A session and its renewal token')
  @Post('/login')
  @HttpCode(200)
  async login(@Body({ schema: loginSchema }) body: LoginInput) {
    const result = await this.authService.signIn(body);

    return result;
  }

  // Each account brings limits of its own, so this bounds how many fresh sets
  // of limits one address can mint.
  @RateLimit(5, hours(1))
  @Public()
  @ApiOperation({ summary: 'Make an account' })
  @ApiData(HttpStatus.CREATED, userView, 'The account')
  @Post('/register')
  async register(@Body({ schema: registerSchema }) body: RegisterInput) {
    const result = await this.authService.register(body);

    return result;
  }

  // A client refreshes once per access token; this bounds the database work
  // of one address replaying stale ones.
  @RateLimit(60, minutes(1))
  @Public()
  @ApiOperation({ summary: 'Renew a session; the token sent is spent' })
  @ApiData(HttpStatus.OK, tokensView, 'A new session and renewal token')
  @Post('/refresh')
  @HttpCode(200)
  async refresh(@Body({ schema: refreshSchema }) body: RefreshInput) {
    const result = await this.authService.refresh(body.refreshToken);

    return result;
  }

  @ApiOperation({ summary: "End every one of the account's sessions" })
  @ApiBearerAuth('session')
  @ApiResponse({ status: HttpStatus.NO_CONTENT, description: 'Signed out' })
  @Post('/logout')
  @HttpCode(204)
  async logout(@CurrentUser() user: AuthenticatedUser) {
    await this.authService.logout(user.id);
  }
}
