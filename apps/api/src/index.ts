import { buildApp } from './server';

const a = await buildApp();
const { app, cfg } = a;
if (cfg.host !== '127.0.0.1' && cfg.host !== 'localhost' && cfg.host !== '::1') app.log.warn('HEPSON_HOST is not loopback: do not expose this API directly to the internet');
await app.listen({ host: cfg.host, port: cfg.port });

let stopping = false;
const stop = async (sig: string) => {
  if (stopping) return;
  stopping = true;
  app.log.info({ sig }, 'shutting down');
  await a.close();
  process.exit(0);
};
process.on('SIGINT', () => void stop('SIGINT'));
process.on('SIGTERM', () => void stop('SIGTERM'));
