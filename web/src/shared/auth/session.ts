/**
 * Сессия для макетов (веха M2).
 *
 * На M3 сюда придёт настоящая аутентификация: JWT, TOTP, профиль из `/auth/me`.
 * Сейчас роль переключается вручную — иначе невозможно показать заказчику,
 * что каждая роль видит свой набор экранов (`SPEC.md § 2.2`).
 *
 * Этот файл целиком заменяется на M3.
 */
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

import type { Role } from '@/api/types';
import { hasPermission, type Permission } from './permissions';

export interface DemoUser {
  id: string;
  name: string;
  role: Role;
  clientId?: string;
  vendorId?: string;
}

export const DEMO_USERS: readonly DemoUser[] = [
  { id: 'usr_admin', name: 'Волкова Анна', role: 'admin' },
  { id: 'usr_disp1', name: 'Карпов Илья', role: 'dispatcher' },
  { id: 'usr_disp2', name: 'Лебедев Пётр', role: 'dispatcher' },
  { id: 'usr_sales', name: 'Орлова Марина', role: 'sales' },
  { id: 'usr_fin', name: 'Зайцева Ольга', role: 'finance' },
  { id: 'usr_mgr', name: 'Соколов Виктор', role: 'manager' },
  { id: 'usr_client', name: 'Нечаев Роман', role: 'client', clientId: 'cli_001' },
  { id: 'usr_vendor', name: 'Громов Сергей', role: 'vendor', vendorId: 'ven_003' },
];

interface SessionState {
  user: DemoUser;
  setUser: (user: DemoUser) => void;
}

const FALLBACK_USER: DemoUser = { id: 'usr_disp1', name: 'Karpov', role: 'dispatcher' };
const DEFAULT_USER: DemoUser = DEMO_USERS[1] ?? FALLBACK_USER;

export const useSession = create<SessionState>()(
  persist(
    (set) => ({
      user: DEFAULT_USER,
      setUser: (user) => {
        set({ user });
      },
    }),
    { name: 'soc.session' },
  ),
);

export function useCurrentUser(): DemoUser {
  return useSession((state) => state.user);
}

export function usePermission(permission: Permission): boolean {
  const role = useSession((state) => state.user.role);
  return hasPermission(role, permission);
}

/** Портальные роли работают в отдельном лейауте с урезанной навигацией. */
export function isPortalRole(role: Role): boolean {
  return role === 'client' || role === 'vendor';
}
