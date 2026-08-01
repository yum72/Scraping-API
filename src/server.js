import { buildApp } from './app.js';

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

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? '0.0.0.0';
const maxConcurrent = Number(process.env.MAX_CONCURRENT_BROWSERS ?? 15);

const app = buildApp({ apiKey, maxConcurrent, logger: true });

const shutdown = async (signal) => {
  app.log.info(`${signal} received, closing`);
  await app.close();
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
