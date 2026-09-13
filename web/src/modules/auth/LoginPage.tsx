import { useState, type JSX } from 'react';
import { Alert, Button, Card, Form, Input, Layout, Space, Typography } from 'antd';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import { ApiError } from '@/api/client';
import { useSession } from '@/shared/auth/session';

/**
 * Вход `[ТЗ 4.3]`.
 *
 * **ADR-013:** аутентификация настоящая всегда. Пароль проверяется сервером,
 * после пяти неудачных попыток учётная запись блокируется на пятнадцать минут,
 * второй фактор запрашивается, если приложение-аутентификатор привязано.
 * Переключателя «войти как» не существует ни в какой сборке: обход
 * аутентификации запрещён.
 *
 * Сообщение об ошибке приходит с сервера и не уточняет, что именно не подошло:
 * иначе форма входа превращается в справочник логинов.
 */
export function LoginPage(): JSX.Element {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const signIn = useSession((s) => s.signIn);
  const submitTwoFactor = useSession((s) => s.submitTwoFactor);

  const [step, setStep] = useState<'credentials' | 'twoFactor'>('credentials');
  const [error, setError] = useState<string | null>(null);
  const [locked, setLocked] = useState(false);
  const [busy, setBusy] = useState(false);

  const handle = async (action: () => Promise<void>): Promise<void> => {
    setBusy(true);
    setError(null);
    setLocked(false);
    try {
      await action();
    } catch (cause) {
      if (cause instanceof ApiError) {
        setError(cause.message);
        setLocked(cause.code === 'ACCOUNT_LOCKED');
      } else {
        setError(t('auth.serverUnavailable'));
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Layout style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 16 }}>
      <Card style={{ width: '100%', maxWidth: 420 }}>
        <Space direction="vertical" size={16} style={{ width: '100%' }}>
          <Space direction="vertical" size={0}>
            <Typography.Title level={4} style={{ margin: 0 }}>
              {t('app.name')}
            </Typography.Title>
            <Typography.Text type="secondary">{t('app.fullName')}</Typography.Text>
          </Space>

          {error ? (
            <Alert type={locked ? 'warning' : 'error'} showIcon message={error} />
          ) : null}

          {step === 'credentials' ? (
            <Form
              layout="vertical"
              onFinish={(values: { username: string; password: string }) => {
                void handle(async () => {
                  const result = await signIn(values.username, values.password);
                  if (result === 'two-factor') {
                    setStep('twoFactor');
                  } else {
                    navigate('/');
                  }
                });
              }}
            >
              <Form.Item
                label={t('auth.username')}
                name="username"
                rules={[{ required: true, message: t('auth.usernameRequired') }]}
              >
                <Input autoComplete="username" size="large" />
              </Form.Item>
              <Form.Item
                label={t('auth.password')}
                name="password"
                rules={[{ required: true, message: t('auth.passwordRequired') }]}
              >
                <Input.Password autoComplete="current-password" size="large" />
              </Form.Item>
              <Button type="primary" htmlType="submit" size="large" block loading={busy}>
                {t('auth.signIn')}
              </Button>
            </Form>
          ) : (
            <Form
              layout="vertical"
              onFinish={(values: { code: string }) => {
                void handle(async () => {
                  await submitTwoFactor(values.code.trim());
                  navigate('/');
                });
              }}
            >
              <Alert type="info" showIcon message={t('auth.twoFactorHint')} />
              <Form.Item
                label={t('auth.twoFactorCode')}
                name="code"
                style={{ marginTop: 12 }}
                rules={[{ required: true, message: t('auth.twoFactorRequired') }]}
              >
                <Input
                  size="large"
                  autoComplete="one-time-code"
                  style={{ fontFamily: "'JetBrains Mono', monospace", letterSpacing: 4 }}
                />
              </Form.Item>
              <Space style={{ width: '100%' }} direction="vertical" size={8}>
                <Button type="primary" htmlType="submit" size="large" block loading={busy}>
                  {t('auth.confirm')}
                </Button>
                <Button
                  type="link"
                  block
                  onClick={() => {
                    setStep('credentials');
                    setError(null);
                  }}
                >
                  {t('common.cancel')}
                </Button>
              </Space>
            </Form>
          )}
        </Space>
      </Card>
    </Layout>
  );
}
