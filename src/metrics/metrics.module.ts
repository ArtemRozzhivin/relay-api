import { type DynamicModule, Module } from '@nestjs/common';
import { collectDefaultMetrics, Registry } from '@prometheus-io/client';
import { MetricsServer } from './metrics.server.js';

export type ProcessRole = 'api' | 'worker';

/**
 * One registry per process, injected by its class. Every series it holds
 * carries `role`, so a dashboard can tell the API's event loop from the
 * worker's, and the process's own runtime metrics are collected with it.
 */
@Module({})
export class MetricsModule {
  static forRoot(role: ProcessRole): DynamicModule {
    return {
      module: MetricsModule,
      global: true,
      providers: [
        {
          provide: Registry,
          useFactory: () => {
            const registry = new Registry();

            registry.setDefaultLabels({ role });
            collectDefaultMetrics({ register: registry });

            return registry;
          },
        },
        MetricsServer,
      ],
      exports: [Registry, MetricsServer],
    };
  }
}
