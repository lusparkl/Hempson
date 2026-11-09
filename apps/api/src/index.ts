import { loadConfig } from './config';
import { buildApp } from './server';
import { alertSender, errorCode } from './services/alerts';

const sendAlert = alertSender(loadConfig());
/** Node would exit here anyway; this tells the operator first. Only the error's name or code goes to Telegram. */
const die = async (what: string, e: unknown): Promise<never> => {
  console.error(e);
  await sendAlert?.(`🔴 CRASH: Hepson API ${what}\nCode: ${errorCode(e)}`).catch(() => undefined);
  process.exit(1);
};
process.on('uncaughtException', (e) => void die('crashed', e));
process.on('unhandledRejection', (e) => void die('crashed', e));

const a = await buildApp().catch((e: unknown) => die('failed to start', e));
const { app, cfg } = a;
if (cfg.host !== '127.0.0.1' && cfg.host !== 'localhost' && cfg.host !== '::1') app.log.warn('HEPSON_HOST is not loopback: do not expose this API directly to the internet');
await app.listen({ host: cfg.host, port: cfg.port }).catch((e: unknown) => die('failed to start', e));

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
