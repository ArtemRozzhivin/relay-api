import { Inject, Injectable } from '@nestjs/common';
import { TerminalJobError } from '../common/errors/app-error.js';
import type { Job } from '../generated/prisma/client.js';
import type { JobContext } from './job-context.js';
import { JOB_HANDLERS, type RunnableJobHandler } from './job-handler.js';
import { JOB_TYPES } from './jobs.schema.js';

@Injectable()
export class JobHandlerRegistry {
  private readonly byType: Map<string, RunnableJobHandler>;

  constructor(@Inject(JOB_HANDLERS) handlers: RunnableJobHandler[]) {
    this.byType = new Map(handlers.map((handler) => [handler.type, handler]));

    // A type that resolves to no handler, or to the wrong one, stays invisible
    // until a job of that type is submitted — and that job pays for it with a
    // burnt attempt and a dead letter. Both roots instantiate this registry at
    // startup, so checking here turns a wiring mistake into a boot failure.
    if (this.byType.size !== handlers.length) {
      throw new Error('Two job handlers claim the same job type');
    }

    const unhandled = JOB_TYPES.filter((type) => !this.byType.has(type));

    if (unhandled.length > 0) {
      throw new Error(
        `No job handler is registered for ${unhandled.join(', ')}`,
      );
    }
  }

  /**
   * Resolves the job's handler and runs it. The handler re-parses the payload
   * before executing.
   *
   * @returns what the handler returns, to be stored as `Job.result`.
   * @throws TerminalJobError when no handler serves the job's type, or the
   * payload does not match that handler's schema. Neither survives a retry, so
   * the caller dead-letters the job instead of spending its attempts.
   */
  async run(job: Job, context: JobContext) {
    const handler = this.byType.get(job.type);

    if (!handler) {
      // A type with no handler is a deployment mistake, not a transient fault:
      // retrying cannot conjure one, so the job dead-letters on first delivery.
      throw new TerminalJobError(
        `No handler is registered for job type ${job.type}`,
      );
    }

    return handler.run(context, job.payload);
  }
}
