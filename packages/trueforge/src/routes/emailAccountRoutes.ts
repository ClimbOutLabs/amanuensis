import {
  GetEmailAccountResponseSchema,
  RemoveEmailAccountResponseSchema,
  SaveEmailAccountRequestSchema,
  SaveEmailAccountResponseSchema,
} from '../schemas/emailAccount';
import { createConnectorAccountRoutes } from './connectorAccountRoutes';

export const emailAccountRoutes = createConnectorAccountRoutes({
  group: 'email',
  noun: 'email account',
  provider: 'the mail server',
  statusSentence: 'its address and provider',
  saveFailureSentence: 'The details could not be used, the password was refused, or the server could not be reached.',
  schemas: {
    get: GetEmailAccountResponseSchema,
    saveRequest: SaveEmailAccountRequestSchema,
    save: SaveEmailAccountResponseSchema,
    remove: RemoveEmailAccountResponseSchema,
  },
});
