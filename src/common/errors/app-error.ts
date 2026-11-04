export type ErrorKind =
  | 'VALIDATION'
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'UNPROCESSABLE'
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

// 422, not 409: the request is well-formed and nothing is in the way of it —
// it is unprocessable as what it claims to be, a retry, because the body
// differs from the one the key was first used with (D28).
export class IdempotencyKeyReusedError extends AppError {
  readonly kind = 'UNPROCESSABLE' as const;
  readonly code = 'IDEMPOTENCY_KEY_REUSED';

  constructor() {
    super(
      'This Idempotency-Key was already used with a different request body',
    );
  }
}

export class TerminalJobError extends AppError {
  readonly kind = 'VALIDATION' as const;
  readonly code = 'JOB_TERMINAL_FAILURE';
}

export class JobNotDeadLetteredError extends AppError {
  readonly kind = 'CONFLICT' as const;
  readonly code = 'JOB_NOT_DEAD_LETTERED';

  constructor() {
    super('Only a dead-lettered job can be re-driven');
  }
}

export class JobAlreadyFinishedError extends AppError {
  readonly kind = 'CONFLICT' as const;
  readonly code = 'JOB_ALREADY_FINISHED';

  constructor() {
    super('Only an unfinished job can be cancelled');
  }
}
