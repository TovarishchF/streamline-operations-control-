import { useEffect, useRef, type JSX } from 'react';
import { Button, Card, Layout, Result, Skeleton } from 'antd';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import { useConfirmRegistration } from '@/api/auth';
import { ApiError } from '@/api/client';

/**
 * Переход по ссылке из письма `[ТЗ 4.3]` (ADR-037).
 *
 * Ссылка одноразовая: в базе лежит её хэш, после перехода он стирается.
 * Повторный переход ошибкой не считается — письмо могли открыть дважды,
 * и пугать человека «ссылка недействительна» там не за что.
 *
 * Заказчику после подтверждения доступ открыт сразу, поставщику —
 * только после решения руководителя, поэтому исход у двух ролей разный.
 */
export function RegistrationConfirmPage(): JSX.Element {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const confirm = useConfirmRegistration();

  const requestId = params.get('id') ?? '';
  const token = params.get('token') ?? '';

  // Подтверждение — побочное действие, а не выборка: повторять его
  // при каждой перерисовке нельзя, ссылка одноразовая.
  const fired = useRef(false);
  useEffect(() => {
    if (fired.current || !requestId || !token) return;
    fired.current = true;
    confirm.mutate({ requestId, token });
  }, [confirm, requestId, token]);

  const goToLogin = (): void => {
    navigate('/login');
  };

  const body = ((): JSX.Element => {
    if (!requestId || !token) {
      return (
        <Result
          status="warning"
          title={t('register.confirmBadLink')}
          extra={
            <Button type="primary" onClick={goToLogin}>
              {t('auth.signIn')}
            </Button>
          }
        />
      );
    }

    if (confirm.isPending || confirm.isIdle) {
      return <Skeleton active paragraph={{ rows: 3 }} />;
    }

    if (confirm.isError) {
      return (
        <Result
          status="error"
          title={t('register.confirmFailed')}
          subTitle={
            confirm.error instanceof ApiError ? confirm.error.message : undefined
          }
          extra={
            <Button onClick={goToLogin}>{t('auth.signIn')}</Button>
          }
        />
      );
    }

    const approved = confirm.data.status === 'approved';
    return (
      <Result
        status="success"
        title={t('register.confirmDone')}
        subTitle={approved ? t('register.confirmAccess') : t('register.confirmQueued')}
        extra={
          <Button type="primary" onClick={goToLogin}>
            {t('auth.signIn')}
          </Button>
        }
      />
    );
  })();

  return (
    <Layout
      className="soc"
      style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 16 }}
    >
      <Card style={{ width: '100%', maxWidth: 520 }}>{body}</Card>
    </Layout>
  );
}
