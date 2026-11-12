/** The calendar day and weekday of an instant in the person's time zone, or UTC when it is missing or unknown. */
export function localDay({ instant, timeZone }: { instant: Date; timeZone?: string | undefined }): {
  date: string;
  weekday: string;
} {
  try {
    return dayIn({ instant, timeZone });
  } catch {
    return dayIn({ instant, timeZone: 'UTC' });
  }
}

function dayIn({ instant, timeZone }: { instant: Date; timeZone?: string | undefined }): {
  date: string;
  weekday: string;
} {
  const zone = timeZone ?? 'UTC';
  return {
    // en-CA writes year-month-day.
    date: instant.toLocaleDateString('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }),
    weekday: instant.toLocaleDateString('en-US', { weekday: 'long', timeZone: zone }),
  };
}
