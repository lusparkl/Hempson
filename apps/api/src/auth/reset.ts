export const RESET_TTL_MS = 3_600_000;

/** The token sits in the URL fragment, so it never reaches a server log or a Referer header. Always built from configuration, never from the request's Host. */
export const resetLink = (dashboardUrl: string, token: string) => `${dashboardUrl}/#reset=${token}`;

export const resetEmail = {
  link: (link: string) => ({
    subject: 'Відновлення пароля Hepson',
    text: `Ви запросили відновлення пароля до кабінету Hepson.\n\nЩоб задати новий пароль, відкрийте посилання (діє 1 годину, лише один раз):\n${link}\n\nЯкщо це були не ви, просто проігноруйте цього листа: пароль не зміниться.`,
  }),
  changed: () => ({
    subject: 'Пароль Hepson змінено',
    text: 'Пароль до вашого кабінету Hepson щойно змінено, а всі попередні сеанси завершено.\n\nЯкщо це були не ви, негайно відновіть пароль через сторінку входу та зверніться до підтримки.',
  }),
};
