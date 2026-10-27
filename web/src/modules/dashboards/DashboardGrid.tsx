import { useState, type CSSProperties, type JSX, type ReactNode } from 'react';
import { App, Button, Card, Dropdown, Space, Tooltip, Typography } from 'antd';
import {
  ArrowDownOutlined, ArrowUpOutlined, CloseOutlined, ColumnHeightOutlined,
  ColumnWidthOutlined, HolderOutlined, MinusOutlined, PlusOutlined, SettingOutlined,
} from '@ant-design/icons';
import { useTranslation } from 'react-i18next';

import { ApiError } from '@/api/client';
import {
  useSaveDashboardLayout,
  type DashboardData,
  type DashboardLayoutItem,
  type DashboardRole,
} from '@/api/reports';
import { useLocalizedName } from '@/shared/i18n/useLocalizedName';

const COLUMNS = 12;
const MAX_HEIGHT = 8;

/** Порядок на экране — по строке, затем по колонке сохранённой раскладки. */
function ordered(items: DashboardLayoutItem[]): DashboardLayoutItem[] {
  return [...items].sort((a, b) => a.y - b.y || a.x - b.x);
}

/**
 * Позиции для сохранения: виджеты укладываются по порядку в первое
 * свободное место сетки — так же, как их раскладывает CSS-сетка
 * (`grid-auto-flow: dense`). Сохранённое совпадает с тем, что на экране,
 * и виджеты не наползают друг на друга.
 */
function pack(items: DashboardLayoutItem[]): DashboardLayoutItem[] {
  const taken = new Set<string>();
  const free = (x: number, y: number, w: number, h: number): boolean => {
    for (let row = y; row < y + h; row += 1) {
      for (let col = x; col < x + w; col += 1) {
        if (taken.has(`${String(col)}:${String(row)}`)) return false;
      }
    }
    return true;
  };
  return items.map((item) => {
    const w = Math.min(COLUMNS, Math.max(1, item.w));
    for (let y = 0; ; y += 1) {
      for (let x = 0; x + w <= COLUMNS; x += 1) {
        if (free(x, y, w, item.h)) {
          for (let row = y; row < y + item.h; row += 1) {
            for (let col = x; col < x + w; col += 1) taken.add(`${String(col)}:${String(row)}`);
          }
          return { ...item, x, y, w };
        }
      }
    }
  });
}

/**
 * Сетка виджетов дашборда `[ТЗ 3.6.2]` (`SPEC.md § 9.2`).
 *
 * Виджеты настраиваются: добавление, удаление, перетаскивание, размер.
 * Раскладка сохраняется на пользователя (`PUT /dashboards/{role}/layout`).
 * Перетаскивание меняет порядок; то же делают кнопки «выше/ниже» —
 * без мыши раскладка настраивается с клавиатуры.
 */
export function DashboardGrid({
  role,
  dashboard,
  render,
}: {
  role: DashboardRole;
  dashboard: DashboardData;
  render: (code: string) => ReactNode;
}): JSX.Element {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const localized = useLocalizedName();
  const save = useSaveDashboardLayout(role);
  const [draft, setDraft] = useState<DashboardLayoutItem[] | null>(null);
  const [dragged, setDragged] = useState<string | null>(null);

  const editing = draft !== null;
  const items = draft ?? ordered(dashboard.layout.widgets);
  const titles = new Map(dashboard.widgets.map((widget) => [widget.code, localized(widget.title)]));
  const hidden = dashboard.widgets.filter((widget) => !items.some((item) => item.code === widget.code));

  const update = (code: string, change: (item: DashboardLayoutItem) => DashboardLayoutItem): void => {
    setDraft(items.map((item) => (item.code === code ? change(item) : item)));
  };

  const move = (code: string, offset: number): void => {
    const index = items.findIndex((item) => item.code === code);
    const target = index + offset;
    if (index < 0 || target < 0 || target >= items.length) return;
    const next = [...items];
    const [moved] = next.splice(index, 1);
    if (moved) next.splice(target, 0, moved);
    setDraft(next);
  };

  const dropOn = (code: string): void => {
    if (!dragged || dragged === code) return;
    const next = items.filter((item) => item.code !== dragged);
    const source = items.find((item) => item.code === dragged);
    const target = next.findIndex((item) => item.code === code);
    if (!source || target < 0) return;
    next.splice(target, 0, source);
    setDraft(next);
    setDragged(null);
  };

  const store = async (): Promise<void> => {
    try {
      await save.mutateAsync(pack(items));
      setDraft(null);
      void message.success(t('dashboard.layoutSaved'));
    } catch (error) {
      void message.error(error instanceof ApiError ? error.message : t('common.saveFailed'));
    }
  };

  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      <Space size={8} wrap style={{ justifyContent: 'flex-end', width: '100%' }}>
        {editing ? (
          <>
            <Dropdown
              disabled={hidden.length === 0}
              menu={{
                items: hidden.map((widget) => ({ key: widget.code, label: localized(widget.title) })),
                onClick: ({ key }) => {
                  setDraft([...items, { code: key, x: 0, y: 0, w: 6, h: 3 }]);
                },
              }}
            >
              <Button icon={<PlusOutlined />}>{t('dashboard.addWidget')}</Button>
            </Dropdown>
            <Button
              onClick={() => {
                setDraft(null);
              }}
            >
              {t('common.cancel')}
            </Button>
            <Button type="primary" loading={save.isPending} onClick={() => { void store(); }}>
              {t('common.save')}
            </Button>
          </>
        ) : (
          <Button
            icon={<SettingOutlined />}
            onClick={() => {
              setDraft(ordered(dashboard.layout.widgets));
            }}
          >
            {t('dashboard.customize')}
          </Button>
        )}
      </Space>

      {items.length === 0 ? (
        <Card>
          <Typography.Text type="secondary">{t('dashboard.emptyLayout')}</Typography.Text>
        </Card>
      ) : null}

      <div className={editing ? 'soc-dash-grid is-editing' : 'soc-dash-grid'}>
        {items.map((item, index) => {
          const style = {
            '--w': String(Math.min(COLUMNS, item.w)),
            '--h': String(item.h),
          } as CSSProperties;
          const title = titles.get(item.code) ?? item.code;
          return (
            <div
              key={item.code}
              className={item.w > COLUMNS / 2 ? 'soc-dash-widget is-wide' : 'soc-dash-widget'}
              style={style}
              draggable={editing}
              onDragStart={() => {
                setDragged(item.code);
              }}
              onDragOver={(event) => {
                if (editing) event.preventDefault();
              }}
              onDrop={() => {
                dropOn(item.code);
              }}
            >
              <Card
                size="small"
                title={
                  <Space size={6}>
                    {editing ? <HolderOutlined aria-hidden className="soc-dash-handle" /> : null}
                    <span>{title}</span>
                  </Space>
                }
                extra={
                  editing ? (
                    <Space size={2} wrap>
                      <Tooltip title={t('dashboard.moveUp')}>
                        <Button
                          size="small" type="text" icon={<ArrowUpOutlined />}
                          aria-label={`${t('dashboard.moveUp')}: ${title}`}
                          disabled={index === 0}
                          onClick={() => { move(item.code, -1); }}
                        />
                      </Tooltip>
                      <Tooltip title={t('dashboard.moveDown')}>
                        <Button
                          size="small" type="text" icon={<ArrowDownOutlined />}
                          aria-label={`${t('dashboard.moveDown')}: ${title}`}
                          disabled={index === items.length - 1}
                          onClick={() => { move(item.code, 1); }}
                        />
                      </Tooltip>
                      <Tooltip title={t('dashboard.narrower')}>
                        <Button
                          size="small" type="text" icon={<MinusOutlined />}
                          aria-label={`${t('dashboard.narrower')}: ${title}`}
                          disabled={item.w <= 2}
                          onClick={() => { update(item.code, (it) => ({ ...it, w: it.w - 1 })); }}
                        />
                      </Tooltip>
                      <Tooltip title={t('dashboard.wider')}>
                        <Button
                          size="small" type="text" icon={<ColumnWidthOutlined />}
                          aria-label={`${t('dashboard.wider')}: ${title}`}
                          disabled={item.w >= COLUMNS}
                          onClick={() => { update(item.code, (it) => ({ ...it, w: it.w + 1 })); }}
                        />
                      </Tooltip>
                      <Tooltip title={t('dashboard.taller')}>
                        <Button
                          size="small" type="text" icon={<ColumnHeightOutlined />}
                          aria-label={`${t('dashboard.taller')}: ${title}`}
                          onClick={() => {
                            update(item.code, (it) => ({ ...it, h: it.h >= MAX_HEIGHT ? 2 : it.h + 1 }));
                          }}
                        />
                      </Tooltip>
                      <Tooltip title={t('dashboard.removeWidget')}>
                        <Button
                          size="small" type="text" danger icon={<CloseOutlined />}
                          aria-label={`${t('dashboard.removeWidget')}: ${title}`}
                          onClick={() => {
                            setDraft(items.filter((other) => other.code !== item.code));
                          }}
                        />
                      </Tooltip>
                    </Space>
                  ) : null
                }
                styles={{ body: { padding: 12 } }}
              >
                {render(item.code)}
              </Card>
            </div>
          );
        })}
      </div>
    </Space>
  );
}
