import { useState, type JSX } from 'react';
import { Alert, Button, Card, Divider, Form, Input, Layout, Select, Space, Typography } from 'antd';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import { DEMO_USERS, useSession } from '@/shared/auth/session';

/**
 * Вход `[ТЗ 4.3]`.
 *
 * **ADR-013:** аутентификация настоящая всегда — пароль проверяется, второй
 * фактор TOTP, блокировка после 5 неудачных попыток. Упрощённый вход
 * (переключатель «Войти как») существует только при `DEMO_DATA=true`
 * и `DEBUG=true`; в боевой сборке он физически отсутствует, а обнаружение
 * демонстрационного бэкенда аутентификации отказывает в запуске.
 *
 * На вехе M2 экран работает на переключателе: сервера ещё нет. Форма пароля
 * и второго фактора нарисована в том виде, в каком заработает на M3.
 */
export function LoginPage(): JSX.Element {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const setUser = useSession((s) => s.setUser);
  const [step, setStep] = useState<'credentials' | 'twoFactor'>('credentials');

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

          {step === 'credentials' ? (
            <Form
              layout="vertical"
              onFinish={() => {
                setStep('twoFactor');
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
              <Button type="primary" htmlType="submit" size="large" block>
                {t('auth.signIn')}
              </Button>
            </Form>
          ) : (
            <Form
              layout="vertical"
              onFinish={() => {
                navigate('/');
              }}
            >
              <Alert type="info" showIcon message={t('auth.twoFactorHint')} />
              <Form.Item
                label={t('auth.twoFactorCode')}
                name="code"
                style={{ marginTop: 12 }}
                rules={[{ required: true, len: 6, message: t('auth.twoFactorRequired') }]}
              >
                <Input
                  size="large"
                  maxLength={6}
                  inputMode="numeric"
                  style={{ fontFamily: "'JetBrains Mono', monospace", letterSpacing: 6 }}
                />
              </Form.Item>
              <Space style={{ width: '100%' }} direction="vertical" size={8}>
                <Button type="primary" htmlType="submit" size="large" block>
                  {t('auth.confirm')}
                </Button>
                <Button
                  type="link"
                  block
                  onClick={() => {
                    setStep('credentials');
                  }}
                >
                  {t('common.cancel')}
                </Button>
              </Space>
            </Form>
          )}

          <Divider style={{ margin: '4px 0' }} plain>
            {t('auth.demoDivider')}
          </Divider>

          <Alert type="warning" showIcon message={t('auth.demoWarning')} />

          <Select
            size="large"
            placeholder={t('auth.signInAs')}
            style={{ width: '100%' }}
            onChange={(id: string) => {
              const user = DEMO_USERS.find((u) => u.id === id);
              if (user) {
                setUser(user);
                navigate('/');
              }
            }}
            options={DEMO_USERS.map((user) => ({
              value: user.id,
              label: `${user.name} — ${t(`roles.${user.role}`)}`,
            }))}
          />
        </Space>
      </Card>
    </Layout>
  );
}
