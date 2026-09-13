import { useState, type JSX } from 'react';
import { Alert, Button, Card, Layout, List, Space, Typography } from 'antd';
import { useTranslation } from 'react-i18next';

import { setupTwoFactor, type TwoFactorSetup } from '@/api/auth';
import { useCurrentUser, useSession } from '@/shared/auth/session';
import { Mono } from '@/shared/ui/primitives';

/**
 * Привязка приложения-аутентификатора `[ТЗ 4.3]`.
 *
 * Показывается администратору и финансисту, пока приложение не привязано:
 * для этих ролей второй фактор обязателен (`BACKEND.md § 6`), а привязать
 * его можно только изнутри системы. Пока привязки нет, других экранов
 * не показывается — требование, которое можно откладывать, не требование.
 *
 * Резервные коды показываются **один раз**: на сервере хранится их хэш,
 * и повторно показать их неоткуда. Каждый срабатывает однократно.
 */
export function TwoFactorSetupPage(): JSX.Element {
  const { t } = useTranslation();
  const user = useCurrentUser();
  const reloadProfile = useSession((s) => s.reloadProfile);
  const signOut = useSession((s) => s.signOut);

  const [setup, setSetup] = useState<TwoFactorSetup | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const start = (): void => {
    setBusy(true);
    setError(null);
    setupTwoFactor()
      .then(setSetup)
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : t('auth.serverUnavailable'));
      })
      .finally(() => {
        setBusy(false);
      });
  };

  return (
    <Layout style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 16 }}>
      <Card style={{ width: '100%', maxWidth: 560 }}>
        <Space direction="vertical" size={16} style={{ width: '100%' }}>
          <Space direction="vertical" size={0}>
            <Typography.Title level={4} style={{ margin: 0 }}>
              {t('auth.twoFactorSetupTitle')}
            </Typography.Title>
            <Typography.Text type="secondary">
              {t('auth.twoFactorSetupSubtitle', {
                role: user ? t(`roles.${user.role}`) : '',
              })}
            </Typography.Text>
          </Space>

          {error ? <Alert type="error" showIcon message={error} /> : null}

          {setup === null ? (
            <>
              <Alert type="info" showIcon message={t('auth.twoFactorSetupHint')} />
              <Button type="primary" size="large" block loading={busy} onClick={start}>
                {t('auth.twoFactorSetupStart')}
              </Button>
              <Button type="link" block onClick={() => void signOut()}>
                {t('auth.signOut')}
              </Button>
            </>
          ) : (
            <>
              <Alert type="success" showIcon message={t('auth.twoFactorSetupDone')} />

              <Space direction="vertical" size={4} style={{ width: '100%' }}>
                <Typography.Text strong>{t('auth.twoFactorSecret')}</Typography.Text>
                <Mono>{setup.secret}</Mono>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {t('auth.twoFactorSecretHint')}
                </Typography.Text>
              </Space>

              <Space direction="vertical" size={4} style={{ width: '100%' }}>
                <Typography.Text strong>{t('auth.backupCodes')}</Typography.Text>
                <Alert type="warning" showIcon message={t('auth.backupCodesWarning')} />
                <List
                  size="small"
                  bordered
                  dataSource={setup.backupCodes}
                  renderItem={(code: string) => (
                    <List.Item>
                      <Mono>{code}</Mono>
                    </List.Item>
                  )}
                />
              </Space>

              <Button type="primary" size="large" block onClick={() => void reloadProfile()}>
                {t('auth.twoFactorSetupContinue')}
              </Button>
            </>
          )}
        </Space>
      </Card>
    </Layout>
  );
}
