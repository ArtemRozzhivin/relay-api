import { execFileSync } from 'node:child_process';

// These assertions need exclusive use of the queue: a worker left behind by an
// interrupted run keeps consuming deliveries the tests are trying to control,
// and the failures then look like queue bugs rather than stray processes.
// Detected rather than killed — the tier does not get to terminate processes it
// did not start.
export function setup() {
  const strays = execFileSync('ps', ['-eo', 'pid,command'], {
    encoding: 'utf8',
  })
    .split('\n')
    .filter((line) => /dist\/(worker|main)\.js/.test(line))
    .map((line) => line.trim());

  if (strays.length > 0) {
    throw new Error(
      [
        `${strays.length} Relay process(es) are already running and will consume`,
        'jobs belonging to these tests:',
        '',
        ...strays,
        '',
        'Stop them first, e.g.  pkill -f dist/worker.js; pkill -f dist/main.js',
      ].join('\n'),
    );
  }
}
