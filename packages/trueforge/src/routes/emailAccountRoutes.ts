import {
  GetEmailAccountResponseSchema,
  RemoveEmailAccountRequestSchema,
  RemoveEmailAccountResponseSchema,
  SaveEmailAccountRequestSchema,
  SaveEmailAccountResponseSchema,
  SetDefaultEmailAccountRequestSchema,
  SetDefaultEmailAccountResponseSchema,
} from '../schemas/emailAccount';
import { createConnectorAccountRoutes } from './connectorAccountRoutes';

export const emailAccountRoutes = createConnectorAccountRoutes({
  group: 'email',
  noun: 'email account',
  provider: 'the mail server',
  statusSentence: 'its accounts and the default among them',
  saveFailureSentence: 'The details could not be used, the password was refused, or the server could not be reached.',
  schemas: {
    get: GetEmailAccountResponseSchema,
    saveRequest: SaveEmailAccountRequestSchema,
    save: SaveEmailAccountResponseSchema,
    removeRequest: RemoveEmailAccountRequestSchema,
    remove: RemoveEmailAccountResponseSchema,
    setDefaultRequest: SetDefaultEmailAccountRequestSchema,
    setDefault: SetDefaultEmailAccountResponseSchema,
  },
});
