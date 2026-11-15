import type { PageKind } from '../../../../src/runtime/memory/memoryPages';
import { pageSlug } from '../../../../src/runtime/memory/pageSlug';

export interface MayaPage {
  title: string;
  kind: PageKind;
  /** Other names the page answers to. */
  names: readonly string[];
  /** Role words that name the page once the person has said so. */
  roles: readonly string[];
}

/** Everyone and everything in Maya's world that could have a page. Maya is the owner and has none. */
export const MAYA_PAGES = {
  nora: { title: 'Nora', kind: 'person', names: [], roles: ['wife'] },
  zoe: { title: 'Zoe', kind: 'person', names: [], roles: ['daughter'] },
  samRossi: { title: 'Sam Rossi', kind: 'person', names: [], roles: ['plumber'] },
  samWhitfield: { title: 'Sam Whitfield', kind: 'person', names: [], roles: [] },
  priya: { title: 'Priya Nair', kind: 'person', names: ['Priya'], roles: ['manager'] },
  tomas: { title: 'Tomás Herrera', kind: 'person', names: ['Tomás'], roles: [] },
  elena: { title: 'Elena Petrova', kind: 'person', names: ['Elena'], roles: [] },
  dimitra: { title: 'Δήμητρα Παππά', kind: 'person', names: ['Δήμητρα', 'Dimitra'], roles: ['architect'] },
  minsu: { title: '김민수', kind: 'person', names: ['Min-su', 'Minsu'], roles: [] },
  marcus: { title: 'Marcus Bell', kind: 'person', names: ['Marcus'], roles: ['accountant'] },
  aiko: { title: 'Aiko Tanaka', kind: 'person', names: ['Aiko'], roles: ['neighbour'] },
  noor: { title: 'Noor Haddad', kind: 'person', names: ['Noor', 'Ms Haddad'], roles: ['teacher'] },
  madrid: { title: 'The Madrid trip', kind: 'matter', names: ['Madrid'], roles: [] },
  kitchen: { title: 'Kitchen renovation', kind: 'matter', names: ['kitchen'], roles: [] },
  taxes: { title: '2025 tax return', kind: 'matter', names: ['tax return'], roles: [] },
  halvorsen: { title: 'Halvorsen proposal', kind: 'matter', names: ['Halvorsen'], roles: [] },
  school: { title: "Zoe's school", kind: 'matter', names: ['school'], roles: [] },
  dentist: { title: 'Family dentist', kind: 'matter', names: ['dentist'], roles: [] },
} as const satisfies Record<string, MayaPage>;

export type MayaPageKey = keyof typeof MAYA_PAGES;

export function mayaPageSlug(key: MayaPageKey): string {
  return pageSlug(MAYA_PAGES[key].title);
}

/** The calendar day of a world day: day 1 is 2026-08-01. */
export function mayaDate(day: number): string {
  return new Date(Date.UTC(2026, 7, day)).toISOString().slice(0, 10);
}

/** The page a slug names, or undefined when the world has no such page. */
export function mayaPageBySlug(slug: string): MayaPage | undefined {
  return Object.values(MAYA_PAGES).find(page => pageSlug(page.title) === slug);
}
