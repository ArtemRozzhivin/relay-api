import { Injectable } from '@nestjs/common';
import { Histogram, Registry } from '@prometheus-io/client';

/** How an attempt ended, as its worker saw it. */
export type AttemptOutcome =
  | 'succeeded'
  // Failed, with another attempt to come.
  | 'retrying'
  | 'dead_lettered'
  | 'cancelled'
  // Stopped for a shutdown and handed to the next worker, uncounted.
  | 'handed_back'
  // Refused by a busy service; the queue waits, and the attempt is uncounted.
  | 'rate_limited'
  // Ended after another attempt had taken the job over; nothing written.
  | 'superseded'
  // Its outcome could not be written; the queue delivers the job again.
  | 'unrecorded';

// From a MOCK job's milliseconds to a 20 000-row import's minutes.
const BUCKETS = [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 300, 600];

/**
 * Times every attempt the worker claims, by job type and outcome. One
 * histogram serves twice: its `_count` per outcome is the attempt counter
 * the failure rate is computed from.
 */
@Injectable()
export class JobMetrics {
  private readonly attempts: Histogram<'type' | 'outcome'>;

  constructor(registry: Registry) {
    this.attempts = new Histogram({
      name: 'relay_job_attempt_duration_seconds',
      help: 'How long an attempt ran, from its claim to its outcome, by job type and outcome',
      labelNames: ['type', 'outcome'],
      buckets: BUCKETS,
      registers: [registry],
    });
  }

  /**
   * Starts timing an attempt that has just been claimed.
   *
   * @returns the function that records it, given how it ended.
   */
  startAttempt(type: string) {
    const end = this.attempts.startTimer({ type });

    return (outcome: AttemptOutcome) => {
      end({ outcome });
    };
  }
}
