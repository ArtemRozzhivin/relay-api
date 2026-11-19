import { Module } from '@nestjs/common';
import { GuardedDownloader } from './guarded-download.js';

// A factory, not the class itself: its constructor takes options only tests
// set, which Nest would otherwise try to inject.
@Module({
  providers: [
    { provide: GuardedDownloader, useFactory: () => new GuardedDownloader() },
  ],
  exports: [GuardedDownloader],
})
export class OutboundModule {}
