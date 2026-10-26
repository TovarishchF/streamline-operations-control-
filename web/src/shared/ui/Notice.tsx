import { useState, type JSX } from 'react';
import { Alert, type AlertProps } from 'antd';

import { useCurrentUser } from '@/shared/auth/session';

/**
 * Табличка-подсказка, которую можно закрыть крестиком.
 *
 * Закрытая табличка не возвращается: отметка хранится у пользователя
 * на этом устройстве. У предупреждения со счётчиком счётчик входит в `id`,
 * поэтому при новом значении («просрочено 4» вместо «3») оно появится снова.
 * Ошибки и сообщения формы этим компонентом не выводятся: их не закрывают,
 * их исправляют.
 */
export function Notice({ id, ...props }: Omit<AlertProps, 'closable'> & { id: string }): JSX.Element | null {
  const user = useCurrentUser();
  const key = `soc.notice.${user?.id ?? 'anonymous'}.${id}`;
  const [hidden] = useState(() => {
    try {
      return window.localStorage.getItem(key) === '1';
    } catch {
      return false;
    }
  });

  if (hidden) return null;

  return (
    <Alert
      {...props}
      closable
      afterClose={() => {
        try {
          window.localStorage.setItem(key, '1');
        } catch {
          // Хранилище недоступно (приватный режим): табличка закроется до перезагрузки.
        }
        props.afterClose?.();
      }}
    />
  );
}
