import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Request, Response } from 'express';
import { AppError, type ErrorKind } from '../errors/app-error.js';

const STATUS_BY_KIND: Record<ErrorKind, HttpStatus> = {
  VALIDATION: HttpStatus.BAD_REQUEST,
  UNAUTHENTICATED: HttpStatus.UNAUTHORIZED,
  FORBIDDEN: HttpStatus.FORBIDDEN,
  NOT_FOUND: HttpStatus.NOT_FOUND,
  CONFLICT: HttpStatus.CONFLICT,
  INTERNAL: HttpStatus.INTERNAL_SERVER_ERROR,
};

interface ErrorBody {
  code: string;
  message: string;
  details?: unknown;
}

@Catch()
export class DomainExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(DomainExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const http = host.switchToHttp();
    const request = http.getRequest<Request>();
    const response = http.getResponse<Response>();

    const requestId =
      (request.headers['x-request-id'] as string | undefined) ?? randomUUID();

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
      ? { code: 'VALIDATION_FAILED', message: 'Request validation failed', details: message }
      : { code, message: message ?? exception.message };
  }
}
