const apiKey = process.env.API_KEY;

// Refuse to start without a key rather than falling back to a default. The
// previous version shipped with the key hardcoded as '1234', which meant every
// deployment that forgot to change it was open to anyone who read the source.
if (!apiKey) {
  console.error('API_KEY is not set. Refusing to start.');
  console.error('Set it in the environment, for example:');
  console.error('  API_KEY=$(openssl rand -hex 24) npm start');
  process.exit(1);
}

// Imported dynamically so a bad PROXIES_FILE reports as one clear line rather
// than a module-load stack trace. The proxy pool is read at import time, which
// is deliberate: a list that cannot be read should stop the server, not be
// discovered on the first request.
let buildApp;
try {
  ({ buildApp } = await import('./app.js'));
} catch (error) {
  console.error(`${error.message}. Refusing to start.`);
  process.exit(1);
}

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? '0.0.0.0';
const maxConcurrent = Number(process.env.MAX_CONCURRENT_BROWSERS ?? 15);
const defaultMaxTimeout = Number(process.env.DEFAULT_TIMEOUT_MS ?? 120_000);
const systemMaxTimeout = Number(process.env.MAX_TIMEOUT_MS ?? 300_000);

const app = buildApp({
  apiKey,
  maxConcurrent,
  defaultMaxTimeout,
  systemMaxTimeout,
  logger: true
});

let shuttingDown = false;

const shutdown = async (signal) => {
  // A second Ctrl-C should not start a parallel teardown while the first is
  // still reaping browsers.
  if (shuttingDown) return;
  shuttingDown = true;

  app.log.info(`${signal} received, closing`);

  // Don't hang forever if a browser refuses to die. app.close() runs the
  // onClose hook that reaps them, but this is the backstop.
  const forceExit = setTimeout(() => {
    app.log.error('shutdown timed out, exiting anyway');
    process.exit(1);
  }, 20_000);
  forceExit.unref();

  try {
    await app.close();
  } catch (error) {
    app.log.error(error, 'error during shutdown');
  }
  process.exit(0);
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

try {
  await app.listen({ port, host });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
