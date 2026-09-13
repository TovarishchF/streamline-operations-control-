import type { JSX } from 'react';
import { Button, Result } from 'antd';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

export function NotFoundPage(): JSX.Element {
  const { t } = useTranslation();
  return (
    <Result
      status="404"
      title="404"
      subTitle={t('errors.NOT_FOUND')}
      extra={
        <Link to="/">
          <Button type="primary">{t('common.toHome')}</Button>
        </Link>
      }
    />
  );
}
