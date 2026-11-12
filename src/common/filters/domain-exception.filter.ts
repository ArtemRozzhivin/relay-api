import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { AppError, type ErrorKind } from '../errors/app-error.js';

const STATUS_BY_KIND: Record<ErrorKind, HttpStatus> = {
  VALIDATION: HttpStatus.BAD_REQUEST,
  UNAUTHENTICATED: HttpStatus.UNAUTHORIZED,
  FORBIDDEN: HttpStatus.FORBIDDEN,
  NOT_FOUND: HttpStatus.NOT_FOUND,
  CONFLICT: HttpStatus.CONFLICT,
  UNPROCESSABLE: HttpStatus.UNPROCESSABLE_ENTITY,
  INTERNAL: HttpStatus.INTERNAL_SERVER_ERROR,
};

interface ErrorBody {
  code: string;
  message: string;
  details?: unknown;
}

// What the body parser throws — a body too large, a charset it cannot read —
// reaches here as an http-errors error, not an HttpException, since Nest
// converts only invalid JSON. `expose` marks the ones meant for the client.
const isClientHttpError = (
  exception: unknown,
): exception is Error & { status: number } =>
  exception instanceof Error &&
  'expose' in exception &&
  exception.expose === true &&
  'status' in exception &&
  typeof exception.status === 'number';

@Catch()
export class DomainExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(DomainExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const http = host.switchToHttp();
    const request = http.getRequest<Request>();
    const response = http.getResponse<Response>();

    const requestId = String(request.id);

    const { status, error } = this.describe(exception, requestId);

    response.status(status).json({ success: false, error, requestId });
  }

  private describe(
    exception: unknown,
    requestId: string,
  ): { status: HttpStatus; error: ErrorBody } {
    if (exception instanceof AppError) {
      return {
        status: STATUS_BY_KIND[exception.kind],
        error: { code: exception.code, message: exception.message },
      };
    }

    if (exception instanceof HttpException) {
      return {
        status: exception.getStatus(),
        error: this.fromHttpException(exception),
      };
    }

    if (isClientHttpError(exception)) {
      return {
        status: exception.status,
        error: {
          code: HttpStatus[exception.status] ?? 'HTTP_ERROR',
          message: exception.message,
        },
      };
    }

    this.logger.error(
      `Unhandled exception [requestId=${requestId}]`,
      exception instanceof Error ? exception.stack : String(exception),
    );

    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      error: { code: 'INTERNAL_ERROR', message: 'Internal server error' },
    };
  }

  private fromHttpException(exception: HttpException): ErrorBody {
    const status = exception.getStatus();
    const payload = exception.getResponse();
    const code = HttpStatus[status] ?? 'HTTP_ERROR';

    if (typeof payload === 'string') {
      return { code, message: payload };
    }

    const { message } = payload as { message?: string | string[] };

    return Array.isArray(message)
      ? {
          code: 'VALIDATION_FAILED',
          message: 'Request validation failed',
          details: message,
        }
      : { code, message: message ?? exception.message };
  }
}
