export type ErrorKind =
  | 'VALIDATION'
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'INTERNAL';

export abstract class AppError extends Error {
  abstract readonly kind: ErrorKind;
  abstract readonly code: string;

  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class InvalidCredentialsError extends AppError {
  readonly kind = 'UNAUTHENTICATED' as const;
  readonly code = 'INVALID_CREDENTIALS';

  constructor() {
    super('Invalid credentials');
  }
}

export class InvalidRefreshTokenError extends AppError {
  readonly kind = 'UNAUTHENTICATED' as const;
  readonly code = 'INVALID_REFRESH_TOKEN';

  constructor() {
    super('Invalid refresh token');
  }
}

export class EmailAlreadyRegisteredError extends AppError {
  readonly kind = 'CONFLICT' as const;
  readonly code = 'EMAIL_ALREADY_REGISTERED';

  constructor() {
    super('Email already registered');
  }
}

export class JobNotFoundError extends AppError {
  readonly kind = 'NOT_FOUND' as const;
  readonly code = 'JOB_NOT_FOUND';

  constructor() {
    super('Job not found');
  }
}

export class IdempotencyKeyRequiredError extends AppError {
  readonly kind = 'VALIDATION' as const;
  readonly code = 'IDEMPOTENCY_KEY_REQUIRED';

  constructor() {
    super('The Idempotency-Key header is required');
  }
}
