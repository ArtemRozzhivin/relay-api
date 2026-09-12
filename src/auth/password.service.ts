import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as argon2 from 'argon2';
import { ApiEnv } from '../config/env.schema.js';

@Injectable()
export class PasswordService {
  constructor(private readonly config: ConfigService<ApiEnv, true>) {}

  async hash(password: string) {
    return await argon2.hash(password, {
      memoryCost: this.config.get('ARGONID_MEMORY_COST', { infer: true }),
      timeCost: this.config.get('ARGONID_TIME_COST', { infer: true }),
    });
  }

  async verify(password: string, hash: string) {
    return await argon2.verify(hash, password);
  }
}
