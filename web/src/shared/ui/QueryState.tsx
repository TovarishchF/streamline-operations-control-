import type { JSX, ReactNode } from 'react';
import { Skeleton } from 'antd';
import type { UseQueryResult } from '@tanstack/react-query';

import { ApiError } from '@/api/client';
import { ErrorState } from './primitives';

/**
 * Три состояния запроса на одном экране: загрузка, ошибка, данные
 * (`CLAUDE.md § 9`).
 *
 * Отдельный компонент, потому что иначе каждый экран рисует их по-своему,
 * а половина — забывает про ошибку и показывает пустую таблицу вместо
 * сообщения «сервер недоступен». Пустой результат — не состояние запроса,
 * а данные: его рисует сам экран, ему виднее, что предложить пользователю.
 */
export function QueryState<T>({
  query,
  children,
  skeletonRows = 6,
}: {
  query: UseQueryResult<T>;
  children: (data: T) => ReactNode;
  skeletonRows?: number;
}): JSX.Element {
  if (query.isPending) {
    return <Skeleton active paragraph={{ rows: skeletonRows }} title={false} />;
  }

  if (query.isError) {
    const code = query.error instanceof ApiError ? query.error.code : undefined;
    return (
      <ErrorState
        {...(code ? { code } : {})}
        onRetry={() => {
          void query.refetch();
        }}
      />
    );
  }

  return <>{children(query.data)}</>;
}
