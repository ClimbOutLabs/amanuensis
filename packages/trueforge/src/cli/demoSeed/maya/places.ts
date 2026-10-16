/**
 * The three clinics of the demo. Streets are real so a map geocodes them; the names are invented, and no
 * price is given.
 */
export interface DemoClinic {
  name: string;
  /** A real street address, so maps resolve it. */
  address: string;
  hours: string;
}

/** Maya's first choice for a regular English-speaking GP. */
export const GP_CLINIC: DemoClinic = {
  name: 'Brightwater Family Clinic',
  address: 'R. de São Bernardo 92, Lisboa',
  hours: 'daily 07:00-22:00',
};

/** The quality backup for the GP search. */
export const BACKUP_CLINIC: DemoClinic = {
  name: 'Linden Court Medical',
  address: 'Av. Conde de Valbom 18-B Galeria D, Lisboa',
  hours: 'Mon-Fri 09:00-19:00',
};

/** Already booked for the visa medical, so it is never suggested as a GP. */
export const VISA_CLINIC: DemoClinic = {
  name: 'Amoreira Health Check',
  address: 'Av. Engenheiro Duarte Pacheco 26, Lisboa',
  hours: 'by appointment',
};

export const CAMERA_SHOP = { name: 'Objectiva Foto', orderNumber: 'OF-2026-10482' };
