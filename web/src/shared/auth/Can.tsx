import type { ReactNode } from 'react';

import { usePermission } from './session';
import type { Permission } from './permissions';

/**
 * Скрывает элемент, недоступный текущей роли.
 *
 * `SPEC.md § 2.3`: скрытие элемента в интерфейсе **не засчитывается** как
 * разграничение доступа — это его видимость. Проверка на сервере обязательна
 * в каждом эндпоинте и возвращает 403.
 */
export function Can({
  permission,
  children,
  fallback = null,
}: {
  permission: Permission;
  children: ReactNode;
  fallback?: ReactNode;
}): ReactNode {
  return usePermission(permission) ? children : fallback;
}
