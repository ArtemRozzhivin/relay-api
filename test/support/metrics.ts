export type Labels = Record<string, string>;

/**
 * The value of every sample of `name` whose labels include `labels`, read from
 * Prometheus's text format: `name{a="1",b="2"} 42`.
 */
export const samples = (text: string, name: string, labels: Labels = {}) =>
  text
    .split('\n')
    .map((line) => /^(\w+)(?:\{(.*)\})? (\S+)$/.exec(line))
    .filter((match) => match?.[1] === name)
    .filter((match) => {
      const found = Object.fromEntries(
        [...(match![2] ?? '').matchAll(/(\w+)="([^"]*)"/g)].map(
          ([, key, value]) => [key, value],
        ),
      );

      return Object.entries(labels).every(
        ([key, value]) => found[key] === value,
      );
    })
    .map((match) => Number(match![3]));

export const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);
