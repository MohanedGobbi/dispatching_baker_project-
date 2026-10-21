import type { Seniority } from '../domain/status';

/**
 * The company's ranks, highest first: Chef crew >= Specialist > OP2 > OP3. A rank is stored as the person's tag; it
 * sets their position and the level the crew rules use (one experienced person per crew).
 */
export const RANKS = {
  CHIEF: { label: 'Chef crew', position: 'Chief of Unit', seniority: 'SENIOR' },
  SPE: { label: 'Specialist', position: 'Field Operator', seniority: 'SENIOR' },
  OP2: { label: 'OP2', position: 'Field Operator', seniority: 'EXPERIENCED' },
  OP3: { label: 'OP3', position: 'Field Operator', seniority: 'JUNIOR' },
} as const satisfies Record<string, { label: string; position: string; seniority: Seniority }>;

export type RankCode = keyof typeof RANKS;

export interface Rank { label: string; position: string; seniority: Seniority }
/** The ranks in order, as the setting `people.ranks` stores them (the manager can rename, add and reorder them). */
export const DEFAULT_RANKS: Rank[] = Object.values(RANKS).map(r => ({ label: r.label, position: r.position, seniority: r.seniority }));
