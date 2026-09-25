import { OAuth2Client } from 'google-auth-library';

/**
 * Доступ только к файлам, которые создал сам бот (книга и папка фото).
 * Остальной Drive аккаунта центра бот не видит.
 */
export const GOOGLE_SCOPES = ['https://www.googleapis.com/auth/drive.file'];

export interface GoogleCredentials {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

export function googleClient(c: GoogleCredentials): OAuth2Client {
  const client = new OAuth2Client({ clientId: c.clientId, clientSecret: c.clientSecret });
  client.setCredentials({ refresh_token: c.refreshToken });
  return client;
}
