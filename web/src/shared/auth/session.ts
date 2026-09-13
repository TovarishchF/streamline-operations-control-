/**
 * Сессия пользователя `[ТЗ 4.3]`.
 *
 * Профиль и карта прав приходят с сервера (`/auth/me`) — руками здесь ничего
 * не задаётся. Карта прав едина с сервером (`BACKEND.md § 6`), и совпадение
 * перечня проверяется тестом `backend/tests/test_permission_map.py`.
 *
 * Хранение токенов — ADR-034: access живёт только в памяти вкладки, refresh
 * в `localStorage`. При каждом обновлении сервер отзывает прежний refresh,
 * поэтому перехваченный токен работает до первого законного обновления.
 *
 * Переключателя ролей здесь нет и быть не может: обход аутентификации
 * запрещён (ADR-013). Чтобы посмотреть систему глазами другой роли, нужно
 * войти под другим пользователем.
 */
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

import {
  fetchMe,
  login as loginRequest,
  logoutRequest,
  refresh as refreshRequest,
  verifyTwoFactor,
  type Me,
  type TokenPair,
} from '@/api/auth';
import { setAccessToken, setRefreshHandler } from '@/api/client';
import type { Role, User } from '@/api/types';
import type { Permission } from './permissions';

export type SessionStatus = 'anonymous' | 'restoring' | 'authenticated';

interface SessionState {
  /** Единственное, что переживает перезагрузку страницы (ADR-034). */
  refreshToken: string | null;
  profile: Me | null;
  status: SessionStatus;

  signIn: (username: string, password: string) => Promise<'ok' | 'two-factor'>;
  submitTwoFactor: (code: string) => Promise<void>;
  signOut: () => Promise<void>;
  restore: () => Promise<void>;
  reloadProfile: () => Promise<void>;
}

/** Временный токен между шагами входа: в хранилище не попадает. */
let twoFactorToken: string | null = null;

export const useSession = create<SessionState>()(
  persist(
    (set, get) => {
      const apply = async (tokens: TokenPair): Promise<void> => {
        setAccessToken(tokens.access);
        set({ refreshToken: tokens.refresh });
        const profile = await fetchMe();
        set({ profile, status: 'authenticated' });
      };

      const clear = (): void => {
        setAccessToken(null);
        twoFactorToken = null;
        set({ refreshToken: null, profile: null, status: 'anonymous' });
      };

      return {
        refreshToken: null,
        profile: null,
        status: 'anonymous',

        signIn: async (username, password) => {
          const response = await loginRequest(username, password);
          if (response.twoFactorRequired) {
            twoFactorToken = response.twoFactorToken ?? null;
            return 'two-factor';
          }
          if (!response.tokens) {
            throw new Error('Сервер не вернул токены');
          }
          await apply(response.tokens);
          return 'ok';
        },

        submitTwoFactor: async (code) => {
          if (!twoFactorToken) {
            throw new Error('Шаг подтверждения не начат');
          }
          await apply(await verifyTwoFactor(twoFactorToken, code));
          twoFactorToken = null;
        },

        signOut: async () => {
          const token = get().refreshToken;
          if (token) {
            // Выход должен завершиться даже если сервер недоступен: иначе
            // пользователь останется в системе на чужом компьютере.
            await logoutRequest(token).catch(() => undefined);
          }
          clear();
        },

        restore: async () => {
          const token = get().refreshToken;
          if (!token) {
            set({ status: 'anonymous' });
            return;
          }
          set({ status: 'restoring' });
          try {
            await apply(await refreshRequest(token));
          } catch {
            clear();
          }
        },

        reloadProfile: async () => {
          set({ profile: await fetchMe() });
        },
      };
    },
    {
      name: 'soc.session',
      // Профиль не сохраняется: он приходит с сервера при восстановлении.
      // Сохранённый профиль означал бы, что права пользователя можно
      // поправить в хранилище браузера.
      partialize: (state) => ({ refreshToken: state.refreshToken }),
    },
  ),
);

/**
 * Обновление токена доступа для транспорта.
 *
 * Подставляется один раз при загрузке модуля: транспорт не должен знать
 * ни про хранилище сессии, ни про форму ответа `/auth/refresh`.
 */
setRefreshHandler(async () => {
  const { refreshToken } = useSession.getState();
  if (!refreshToken) return false;
  try {
    const tokens = await refreshRequest(refreshToken);
    setAccessToken(tokens.access);
    useSession.setState({ refreshToken: tokens.refresh });
    return true;
  } catch {
    setAccessToken(null);
    useSession.setState({ refreshToken: null, profile: null, status: 'anonymous' });
    return false;
  }
});

export function useCurrentUser(): User | null {
  return useSession((state) => state.profile?.user ?? null);
}

export function useIsAuthenticated(): boolean {
  return useSession((state) => state.status === 'authenticated');
}

/**
 * Политика требует второй фактор, а приложение не привязано.
 *
 * До привязки интерфейс не показывает ничего, кроме экрана привязки:
 * требование политики, которое можно бесконечно откладывать, — не требование.
 */
export function useTwoFactorSetupRequired(): boolean {
  return useSession((state) => state.profile?.twoFactorSetupRequired === true);
}

export function usePermission(permission: Permission): boolean {
  return useSession((state) => state.profile?.permissions[permission] === true);
}

/**
 * Карта прав целиком: для фильтрации списков пунктов навигации.
 *
 * Отдельный хук, а не вызов `usePermission` в цикле: количество хуков
 * не может зависеть от длины списка.
 */
export function usePermissionMap(): Readonly<Record<string, boolean>> {
  return useSession((state) => state.profile?.permissions ?? EMPTY_PERMISSIONS);
}

/** Стабильная ссылка: новый объект на каждый вызов вызывал бы перерисовку. */
const EMPTY_PERMISSIONS: Readonly<Record<string, boolean>> = Object.freeze({});

/** Портальные роли работают в отдельном лейауте с урезанной навигацией. */
export function isPortalRole(role: Role): boolean {
  return role === 'client' || role === 'vendor';
}
