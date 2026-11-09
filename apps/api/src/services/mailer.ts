import nodemailer from 'nodemailer';
import type { Config } from '../config';

export type Mail = { to: string; subject: string; text: string };
export type Mailer = { send(mail: Mail): Promise<void>; verify?(): Promise<void> };
type Smtp = NonNullable<Config['smtp']>;

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1']);

/** STARTTLS is mandatory on port 587 and others (implicit TLS on 465), so credentials and links never cross the network in the clear; only a local mock may skip it. */
export const smtpOptions = (s: Smtp) => ({
  host: s.host,
  port: s.port,
  secure: s.port === 465,
  requireTLS: s.port !== 465 && !LOOPBACK.has(s.host),
  ignoreTLS: LOOPBACK.has(s.host),
  ...(s.user ? { auth: { user: s.user, pass: s.password ?? '' } } : {}),
  connectionTimeout: 10_000,
  greetingTimeout: 10_000,
  socketTimeout: 20_000,
});

/** Account email (D46). SMTP is not HTTP, so it is outside the egress allow-list (D22); the only destination is the operator's own configured server. */
export class SmtpMailer implements Mailer {
  private transport;
  constructor(private s: Smtp) {
    this.transport = nodemailer.createTransport(smtpOptions(s));
  }
  async send(mail: Mail): Promise<void> {
    await this.transport.sendMail({ from: this.s.from, ...mail });
  }
  /** Connects and logs in without sending anything. */
  async verify(): Promise<void> {
    await this.transport.verify();
  }
}
