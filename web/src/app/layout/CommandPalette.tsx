import { useEffect, useMemo, useState, type JSX, type KeyboardEvent } from 'react';
import { Modal } from 'antd';
import { AppstoreOutlined, SearchOutlined, SendOutlined } from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import { useFlights } from '@/api/flights';
import { useSampleDataMode, usePermissionMap } from '@/shared/auth/session';
import { FlightStatusTag } from '@/shared/ui/primitives';
import { visibleItems } from './NavRail';

/** Задержка поиска: запрос уходит, когда человек перестал печатать. */
const DEBOUNCE_MS = 150;

interface Result {
  key: string;
  group: 'flights' | 'screens';
  title: string;
  context?: string;
  status?: string;
  path: string;
}

/**
 * Палитра команд: Ctrl K / ⌘K — переход к любому рейсу и экрану
 * (карточка CommandPalette дизайн-системы).
 *
 * Рейсы ищутся тем же списочным эндпоинтом, что и суточный план; экраны —
 * по навигации с учётом прав. Права на сервере от этого не меняются:
 * палитра только сокращает путь.
 */
export function CommandPalette({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}): JSX.Element {
  return (
    <Modal
      open={open}
      onCancel={onClose}
      footer={null}
      closable={false}
      width={640}
      style={{ top: '20%' }}
      destroyOnClose
      className="soc-palette"
      styles={{ content: { padding: 0 } }}
    >
      {open ? <PaletteBody onClose={onClose} /> : null}
    </Modal>
  );
}

function PaletteBody({ onClose }: { onClose: () => void }): JSX.Element {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const permissions = usePermissionMap();
  const sampleData = useSampleDataMode();
  const [text, setText] = useState('');
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setQuery(text.trim());
    }, DEBOUNCE_MS);
    return () => {
      window.clearTimeout(timer);
    };
  }, [text]);

  // Без текста рейсы не показываются: первая страница списка — не результат поиска.
  const flights = useFlights({ search: query, perPage: 6 });
  const flightRows = useMemo(
    () => (query === '' ? [] : (flights.data?.data ?? [])),
    [query, flights.data],
  );

  const results = useMemo<Result[]>(() => {
    const needle = query.toLocaleLowerCase('ru');
    const screens = visibleItems(permissions, sampleData)
      .flatMap((group) => group.items)
      .flatMap((item) => [item, ...(item.children ?? [])])
      .filter((screen) => permissions[screen.permission] === true)
      .map((screen) => ({ key: `s:${screen.path}`, label: t(screen.labelKey), path: screen.path }))
      .filter((screen, index, all) => all.findIndex((s) => s.path === screen.path) === index)
      .filter((screen) => needle === '' || screen.label.toLocaleLowerCase('ru').includes(needle))
      .slice(0, 6)
      .map<Result>((screen) => ({
        key: screen.key, group: 'screens', title: screen.label, path: screen.path,
      }));

    const found = flightRows.map<Result>((flight) => ({
      key: `f:${flight.id}`,
      group: 'flights',
      title: flight.number,
      context: `${flight.depIcao} → ${flight.arrIcao} · ${flight.clientName}`,
      status: flight.status,
      path: `/flights/${flight.id}`,
    }));

    return [...found, ...screens];
  }, [sampleData, flightRows, permissions, query, t]);

  const current = Math.min(active, Math.max(results.length - 1, 0));

  const run = (result: Result | undefined): void => {
    if (!result) return;
    onClose();
    navigate(result.path);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActive((current + 1) % Math.max(results.length, 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActive((current - 1 + results.length) % Math.max(results.length, 1));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      run(results[current]);
    }
  };

  const groups: Array<Result['group']> = ['flights', 'screens'];

  return (
    <div className="soc-palette__panel">
      <div className="soc-palette__input">
        <SearchOutlined />
        <input
          autoFocus
          value={text}
          onChange={(event) => {
            setText(event.target.value);
            setActive(0);
          }}
          onKeyDown={onKeyDown}
          placeholder={t('nav.searchPlaceholder')}
          aria-label={t('nav.search')}
          role="combobox"
          aria-expanded="true"
          aria-controls="soc-palette-list"
        />
        <span className="soc-kbd">Esc</span>
      </div>

      <div className="soc-palette__list" id="soc-palette-list" role="listbox">
        {results.length === 0 ? (
          <div className="soc-palette__empty">{t('palette.empty')}</div>
        ) : (
          groups.map((group) => {
            const items = results.filter((result) => result.group === group);
            if (items.length === 0) return null;
            return (
              <div key={group}>
                <div className="soc-palette__group">{t(`palette.${group}`)}</div>
                {items.map((result) => {
                  const index = results.indexOf(result);
                  const isActive = index === current;
                  return (
                    <div
                      key={result.key}
                      role="option"
                      aria-selected={isActive}
                      className={isActive ? 'soc-palette__item is-active' : 'soc-palette__item'}
                      onMouseEnter={() => {
                        setActive(index);
                      }}
                      onClick={() => {
                        run(result);
                      }}
                    >
                      <span className="soc-palette__ico" aria-hidden="true">
                        {group === 'flights' ? <SendOutlined /> : <AppstoreOutlined />}
                      </span>
                      <span className="soc-palette__main">
                        <span className={group === 'flights' ? 'soc-code' : undefined}>
                          {result.title}
                        </span>
                        {result.context ? (
                          <span className="soc-palette__context">{result.context}</span>
                        ) : null}
                      </span>
                      {result.status ? <FlightStatusTag status={result.status} size="sm" /> : null}
                    </div>
                  );
                })}
              </div>
            );
          })
        )}
      </div>

      <div className="soc-palette__foot">
        <span>
          <span className="soc-kbd">↑</span>
          <span className="soc-kbd">↓</span>
          {t('palette.move')}
        </span>
        <span>
          <span className="soc-kbd">Enter</span>
          {t('palette.open')}
        </span>
        <span>
          <span className="soc-kbd">Esc</span>
          {t('palette.close')}
        </span>
      </div>
    </div>
  );
}
