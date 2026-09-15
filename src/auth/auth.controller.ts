import { Body, Controller, HttpCode, Post } from '@nestjs/common';
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

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Public()
  @Post('/login')
  @HttpCode(200)
  async login(@Body({ schema: loginSchema }) body: LoginInput) {
    const result = await this.authService.signIn(body);

    return result;
  }

  @Public()
  @Post('/register')
  async register(@Body({ schema: registerSchema }) body: RegisterInput) {
    const result = await this.authService.register(body);

    return result;
  }

  @Public()
  @Post('/refresh')
  @HttpCode(200)
  async refresh(@Body({ schema: refreshSchema }) body: RefreshInput) {
    const result = await this.authService.refresh(body.refreshToken);

    return result;
  }

  @Post('/logout')
  @HttpCode(204)
  async logout(@CurrentUser() user: AuthenticatedUser) {
    await this.authService.logout(user.id);
  }
}
