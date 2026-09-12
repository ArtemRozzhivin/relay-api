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

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('/login')
  @HttpCode(200)
  async login(@Body({ schema: loginSchema }) body: LoginInput) {
    const result = await this.authService.signIn(body);

    return result;
  }

  @Post('/register')
  async register(@Body({ schema: registerSchema }) body: RegisterInput) {
    const result = await this.authService.register(body);

    return result;
  }

  @Post('/refresh')
  @HttpCode(200)
  async refresh(@Body({ schema: refreshSchema }) body: RefreshInput) {
    const result = await this.authService.refresh(body.refreshToken);

    return result;
  }

  @Post('/logout')
  @HttpCode(204)
  async logout(userId: string) {
    await this.authService.logout(userId);
  }
}
