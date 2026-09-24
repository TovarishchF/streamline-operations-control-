import { useState, type JSX } from 'react';
import { Alert, Button, Card, Form, Input, Layout, Space, Tag, Typography } from 'antd';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import { useDemoAccounts, type DemoAccount } from '@/api/auth';
import { RegistrationModal } from './RegistrationModal';
import { ApiError } from '@/api/client';
import { SOC_COLORS, SOC_RADIUS } from '@/app/theme';
import { useSession } from '@/shared/auth/session';

/**
 * Вход `[ТЗ 4.3]`.
 *
 * **ADR-013:** аутентификация настоящая всегда. Пароль проверяется сервером,
 * после пяти неудачных попыток учётная запись блокируется на пятнадцать минут,
 * второй фактор запрашивается, если приложение-аутентификатор привязано.
 * Переключателя «войти как» не существует ни в какой сборке: обход
 * аутентификации запрещён. Список учётных записей на стенде — не обход:
 * он подставляет **логин**, пароль по-прежнему набирается, и вход идёт
 * обычным путём через сервер.
 *
 * Сообщение об ошибке приходит с сервера и не уточняет, что именно не подошло:
 * иначе форма входа превращается в справочник логинов.
 */
export function LoginPage(): JSX.Element {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const signIn = useSession((s) => s.signIn);
  const submitTwoFactor = useSession((s) => s.submitTwoFactor);

  const [form] = Form.useForm<{ username: string; password: string }>();
  const accounts = useDemoAccounts().data ?? [];
  // Пришли по «Сменить сотрудника» — список сотрудников стоит над формой:
  // выбирают из него, а не набирают логин заново.
  const switching = useSearchParams()[0].get('switch') === '1';
  const [registering, setRegistering] = useState(false);

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
    <Layout
      className="soc"
      style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 16 }}
    >
      <Card style={{ width: '100%', maxWidth: 420 }}>
        <Space direction="vertical" size={16} style={{ width: '100%' }}>
          {/* Цветная версия знака — на белом; в тёмной обвязке стоит
              белая. Входящий видит, чья это система, до ввода логина. */}
          <Space direction="vertical" size={10}>
            <img
              src="/brand/streamline-fs.png"
              alt={t('app.fullName')}
              style={{ height: 36, width: 'auto', display: 'block' }}
            />
            <Typography.Text type="secondary">{t('app.fullName')}</Typography.Text>
          </Space>

          {error ? (
            <Alert type={locked ? 'warning' : 'error'} showIcon message={error} />
          ) : null}

          {step === 'credentials' && switching && accounts.length > 0 ? (
            <Space direction="vertical" size={6} style={{ width: '100%' }}>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {t('auth.pickAccount')}
              </Typography.Text>
              <Space size={6} wrap>
                {accounts.map((account) => (
                  <AccountChip
                    key={account.username}
                    account={account}
                    onPick={() => {
                      form.setFieldsValue({ username: account.username, password: '' });
                      form.focusField('password');
                    }}
                  />
                ))}
              </Space>
            </Space>
          ) : null}

          {step === 'credentials' ? (
            <Form
              form={form}
              name="login"
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

              <Space size={6} style={{ marginTop: 12 }}>
                <Typography.Text type="secondary" style={{ fontSize: 13 }}>
                  {t('register.haveNoAccount')}
                </Typography.Text>
                {/* Настоящая кнопка, а не `<a>` без адреса: ссылка без
                    `href` не получает фокус, и клавиатура её пропускает. */}
                <Button
                  type="link"
                  style={{ padding: 0, height: 'auto' }}
                  onClick={() => {
                    setRegistering(true);
                  }}
                >
                  {t('register.openForm')}
                </Button>
              </Space>

              {accounts.length > 0 && !switching ? (
                <Space direction="vertical" size={6} style={{ width: '100%', marginTop: 16 }}>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {t('auth.pickAccount')}
                  </Typography.Text>
                  <Space size={6} wrap>
                    {accounts.map((account) => (
                      <AccountChip
                        key={account.username}
                        account={account}
                        onPick={() => {
                          form.setFieldsValue({ username: account.username, password: '' });
                          form.focusField('password');
                        }}
                      />
                    ))}
                  </Space>
                </Space>
              ) : null}
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

      <RegistrationModal
        open={registering}
        onClose={() => {
          setRegistering(false);
        }}
      />
    </Layout>
  );
}

/**
 * Учётная запись стенда одним нажатием.
 *
 * Подставляет **логин** и переводит фокус на пароль: набор сокращается
 * на одну строку, вход остаётся настоящим (ADR-013).
 */
function AccountChip({
  account,
  onPick,
}: {
  account: DemoAccount;
  onPick: () => void;
}): JSX.Element {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      onClick={onPick}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        height: 28,
        paddingInline: 10,
        borderRadius: SOC_RADIUS.pill,
        border: `1px solid ${SOC_COLORS.border}`,
        background: SOC_COLORS.surface,
        color: SOC_COLORS.inkSecondary,
        font: 'inherit',
        cursor: 'pointer',
      }}
    >
      {account.name}
      <Tag
        style={{
          margin: 0,
          borderRadius: SOC_RADIUS.pill,
          background: SOC_COLORS.surfaceSunken,
          borderColor: SOC_COLORS.border,
          color: SOC_COLORS.inkTertiary,
          fontSize: 11,
          lineHeight: '16px',
        }}
      >
        {t(`role.${account.role}`, account.role)}
      </Tag>
    </button>
  );
}
