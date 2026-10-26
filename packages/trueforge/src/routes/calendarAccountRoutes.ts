import {
  GetCalendarAccountResponseSchema,
  RemoveCalendarAccountResponseSchema,
  SaveCalendarAccountRequestSchema,
  SaveCalendarAccountResponseSchema,
} from '../schemas/calendarAccount';
import { createConnectorAccountRoutes } from './connectorAccountRoutes';

export const calendarAccountRoutes = createConnectorAccountRoutes({
  group: 'calendar',
  noun: 'calendar account',
  provider: 'the calendar server',
  statusSentence: 'its email, login and calendar address',
  saveFailureSentence:
    'The details could not be used, the address is not allowed, the password was refused, or the server could not be reached.',
  schemas: {
    get: GetCalendarAccountResponseSchema,
    saveRequest: SaveCalendarAccountRequestSchema,
    save: SaveCalendarAccountResponseSchema,
    remove: RemoveCalendarAccountResponseSchema,
  },
});
