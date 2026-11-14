import {
  GetCalendarAccountResponseSchema,
  RemoveCalendarAccountRequestSchema,
  RemoveCalendarAccountResponseSchema,
  SaveCalendarAccountRequestSchema,
  SaveCalendarAccountResponseSchema,
  SetDefaultCalendarAccountRequestSchema,
  SetDefaultCalendarAccountResponseSchema,
} from '../schemas/calendarAccount';
import { createConnectorAccountRoutes } from './connectorAccountRoutes';

export const calendarAccountRoutes = createConnectorAccountRoutes({
  group: 'calendar',
  noun: 'calendar account',
  provider: 'the calendar server',
  statusSentence: 'its accounts and the default among them',
  saveFailureSentence:
    'The details could not be used, the address is not allowed, the password was refused, or the server could not be reached.',
  schemas: {
    get: GetCalendarAccountResponseSchema,
    saveRequest: SaveCalendarAccountRequestSchema,
    save: SaveCalendarAccountResponseSchema,
    removeRequest: RemoveCalendarAccountRequestSchema,
    remove: RemoveCalendarAccountResponseSchema,
    setDefaultRequest: SetDefaultCalendarAccountRequestSchema,
    setDefault: SetDefaultCalendarAccountResponseSchema,
  },
});
