// Role matrix from plan section 3. Base scope is enforced separately by the guard.
export type Role = 'SUPER_ADMIN' | 'OPS_MANAGER' | 'DISPATCHER' | 'HR' | 'BASE_MANAGER' | 'CHIEF_OF_UNIT' | 'EMPLOYEE';
export type Level = 'none' | 'view' | 'edit' | 'full';
export type Module =
  | 'settings' | 'users' | 'bases' | 'positions' | 'employees' | 'units' | 'jobs' | 'assignments'
  | 'planning' | 'leave' | 'medical' | 'extensions' | 'maintenance' | 'analytics' | 'audit';

const ALL: Module[] = ['settings', 'users', 'bases', 'positions', 'employees', 'units', 'jobs', 'assignments',
  'planning', 'leave', 'medical', 'extensions', 'maintenance', 'analytics', 'audit'];

export const MATRIX: Record<Role, Partial<Record<Module, Level>>> = {
  SUPER_ADMIN: Object.fromEntries(ALL.map(m => [m, 'full'])),
  OPS_MANAGER: { settings: 'view', users: 'view', bases: 'full', positions: 'full', employees: 'full', units: 'full', jobs: 'full', assignments: 'full', planning: 'full', leave: 'full', medical: 'view', extensions: 'full', maintenance: 'full', analytics: 'full', audit: 'view' },
  DISPATCHER: { bases: 'view', positions: 'view', employees: 'edit', units: 'edit', jobs: 'full', assignments: 'full', planning: 'edit', leave: 'view', extensions: 'edit', maintenance: 'view', analytics: 'view' },
  HR: { bases: 'view', positions: 'full', employees: 'full', units: 'view', assignments: 'view', leave: 'full', medical: 'full', extensions: 'view', analytics: 'view', audit: 'view' },
  BASE_MANAGER: { bases: 'view', positions: 'view', employees: 'view', units: 'edit', jobs: 'view', assignments: 'edit', planning: 'edit', leave: 'edit', extensions: 'edit', maintenance: 'full', analytics: 'view' },
  CHIEF_OF_UNIT: { bases: 'view', employees: 'view', units: 'view', jobs: 'view', assignments: 'view', leave: 'view', extensions: 'edit', maintenance: 'edit' },
  EMPLOYEE: { employees: 'view', jobs: 'view', assignments: 'view', leave: 'edit', medical: 'edit', extensions: 'view', maintenance: 'view', analytics: 'view' },
};

const RANK: Record<Level, number> = { none: 0, view: 1, edit: 2, full: 3 };

export function can(roles: string[], module: Module, need: Level): boolean {
  return roles.some(r => RANK[MATRIX[r as Role]?.[module] ?? 'none'] >= RANK[need]);
}
