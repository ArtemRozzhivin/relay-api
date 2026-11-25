export type ErrorKind =
  | 'VALIDATION'
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'UNPROCESSABLE'
  | 'LIMIT_REACHED'
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

export class IdempotencyKeyReservedError extends AppError {
  readonly kind = 'VALIDATION' as const;
  readonly code = 'IDEMPOTENCY_KEY_RESERVED';

  constructor(prefix: string) {
    super(
      `An Idempotency-Key may not begin with "${prefix}", which the keys of a pipeline's own jobs use`,
    );
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

export class ErrorReportNotFoundError extends AppError {
  readonly kind = 'NOT_FOUND' as const;
  readonly code = 'ERROR_REPORT_NOT_FOUND';

  constructor() {
    super(
      'This job has no error report: it has not finished, every row was valid, or the report has expired',
    );
  }
}

// 422 like a reused key: the body is well-formed, but what it names is not
// there. One answer for "not yours" and "not uploaded", so a probe for another
// tenant's key learns nothing from the difference.
export class PipelineNotFoundError extends AppError {
  readonly kind = 'NOT_FOUND' as const;
  readonly code = 'PIPELINE_NOT_FOUND';

  constructor() {
    super('Pipeline not found');
  }
}

export class ApiKeysDisabledError extends AppError {
  readonly kind = 'FORBIDDEN' as const;
  readonly code = 'API_KEYS_DISABLED';

  constructor() {
    super('API keys are turned off on this server');
  }
}

export class ApiKeyNotAllowedError extends AppError {
  readonly kind = 'FORBIDDEN' as const;
  readonly code = 'API_KEY_NOT_ALLOWED';

  constructor() {
    super('An API key cannot be used here; sign in instead');
  }
}

export class ApiKeyScopeMissingError extends AppError {
  readonly kind = 'FORBIDDEN' as const;
  readonly code = 'API_KEY_SCOPE_MISSING';

  constructor(scope: string) {
    super(`This API key does not have the ${scope} scope`);
  }
}

export class ApiKeyNotFoundError extends AppError {
  readonly kind = 'NOT_FOUND' as const;
  readonly code = 'API_KEY_NOT_FOUND';

  constructor() {
    super('API key not found');
  }
}

export class UploadNotFoundError extends AppError {
  readonly kind = 'UNPROCESSABLE' as const;
  readonly code = 'UPLOAD_NOT_FOUND';

  constructor() {
    super('No upload of yours exists at this key');
  }
}

export class TerminalJobError extends AppError {
  readonly kind = 'VALIDATION' as const;
  readonly code = 'JOB_TERMINAL_FAILURE';

  /**
   * @param reason the handler's own name for this failure, stored on the dead
   * letter beside the engine's `TERMINAL_FAILURE`, so a client can tell one
   * terminal failure from another without reading the message.
   */
  constructor(
    message: string,
    readonly reason?: string,
  ) {
    super(message);
  }
}

/**
 * A handler's failure that another attempt might not repeat — a host that
 * timed out, say — with a message written for the job's owner. A plain `Error`
 * is retried the same way, but its message is never shown: it may be Prisma's,
 * S3's or a socket's, and name what the owner should not see.
 */
export class RetryableJobError extends AppError {
  // Never answered over HTTP; were it thrown there, a 500 is what it would be.
  readonly kind = 'INTERNAL' as const;
  readonly code = 'JOB_ATTEMPT_FAILED';
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

// A conflict with the job's role, not its state: a pipeline is finished by its
// one summary job, and nothing would ever write a second.
export class JobNotCancellableError extends AppError {
  readonly kind = 'CONFLICT' as const;
  readonly code = 'JOB_NOT_CANCELLABLE';

  constructor() {
    super(
      "A pipeline's summary job finishes the pipeline; it cannot be cancelled",
    );
  }
}

// 429, as a rate limit is: nothing is wrong with the request, and the same one
// succeeds later. But no Retry-After — the place frees when one of the
// account's jobs finishes, and only the jobs know when that is.
export class TooManyUnfinishedJobsError extends AppError {
  readonly kind = 'LIMIT_REACHED' as const;
  readonly code = 'TOO_MANY_UNFINISHED_JOBS';

  constructor(type: string, cap: number) {
    super(
      `At most ${cap} ${type} jobs can be unfinished at once; send this one when one of them finishes`,
    );
  }
}

// 429 like a cap on jobs, and for the same reason no Retry-After: the place
// frees when the running pipeline finishes.
export class TooManyRunningPipelinesError extends AppError {
  readonly kind = 'LIMIT_REACHED' as const;
  readonly code = 'TOO_MANY_RUNNING_PIPELINES';

  constructor() {
    super('One pipeline can run at a time; start the next when it finishes');
  }
}

export class TooManyApiKeysError extends AppError {
  readonly kind = 'LIMIT_REACHED' as const;
  readonly code = 'TOO_MANY_API_KEYS';

  constructor(max: number) {
    super(
      `At most ${max} API keys can be unrevoked at once; revoke one to make another`,
    );
  }
}

export class TooManyUploadsError extends AppError {
  readonly kind = 'LIMIT_REACHED' as const;
  readonly code = 'TOO_MANY_UPLOADS';

  constructor(perDay: number) {
    super(`At most ${perDay} uploads can be started in 24 hours`);
  }
}
