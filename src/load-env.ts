// Imported first by the worker's entry point. A processor's concurrency and
// rate limit are read from the environment as the module declaring them loads,
// before ConfigModule has read .env, so .env is loaded here, ahead of them. A
// variable already set in the environment wins, and production has no .env.
try {
  process.loadEnvFile();
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
    throw error;
  }
}
