import { Reflector } from '@nestjs/core';
import { Role } from '../../generated/prisma/enums.js';

export const Roles = Reflector.createDecorator<Role[]>();
