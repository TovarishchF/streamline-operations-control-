import {
  useMemo, useState, type HTMLAttributes, type JSX, type PointerEvent, type ReactNode,
} from 'react';
import { Button, Input, Space, Table } from 'antd';
import { SearchOutlined } from '@ant-design/icons';
import type { ColumnType, TableProps } from 'antd/es/table';
import type { FilterDropdownProps } from 'antd/es/table/interface';
import { useTranslation } from 'react-i18next';

/**
 * Таблица с сортировкой по каждой колонке и изменяемой шириной столбцов.
 *
 * `CLAUDE.md § 10`: аудитория — диспетчеры и финансисты, которым нужна плотная
 * таблица. Отсортировать по любому полю и подогнать ширину под свои данные —
 * базовая потребность, а не украшение.
 *
 * Сортировка добавляется автоматически каждой колонке с `dataIndex`, у которой
 * её нет: писать `sorter` руками в сорока таблицах — гарантированно забыть
 * в половине. Колонка отказывается явным `sortable: false`.
 *
 * Ширина меняется перетаскиванием края заголовка. Сторонняя библиотека для
 * этого не заводится (`CLAUDE.md § 5` — новая зависимость по согласованию):
 * хватает указателя и одного обработчика.
 *
 * Пока ширину не трогали, браузер раскладывает колонки сам: заданная ширина
 * для него — подсказка, остаток места делится между колонками. Тянуть
 * колонку в такой раскладке нельзя: край отстаёт от указателя, соседние
 * колонки меняют ширину сами, а колонка правее «резиновой» растёт влево.
 * Поэтому первое же перетаскивание замораживает **все** колонки на их
 * фактической ширине, и дальше меняется только та, которую тянут: таблица
 * становится шире и прокручивается, а свободное место справа занимает
 * пустая колонка-заполнитель. Ширина считается от начала жеста, а не
 * от прошлого шага: упёршись в предел, край не отстаёт от указателя.
 *
 * Ширина ограничена с обеих сторон: перетаскиванием колонку нельзя сжать
 * меньше `minWidth` (по умолчанию 80 px) и растянуть больше `maxWidth`
 * (640 px). Колонка без заданной ширины не сжимается меньше 140 px —
 * таблица прокручивается в своей карточке, а не давит текст в столбик.
 *
 * Фильтр по значениям добавляется сам колонке, где от двух до двенадцати
 * разных простых значений и они повторяются: статус, тип, валюта. Пункты
 * фильтра — те же ячейки, что в таблице (пилюля статуса, а не код).
 * На таблицах с серверной разбивкой на страницы фильтр не добавляется:
 * он отбирал бы только текущую страницу. Колонка отказывается от фильтра
 * через `filterable: false` и просит поиск по подстроке через `'text'`.
 *
 * Внутри колонки обрабатываются как узкий `RawColumn`, а не как обобщённый
 * `ColumnType<T>`: полный обобщённый тип Ant Design разворачивается настолько,
 * что типизированный линтер исчерпывает память на этом файле.
 */

export interface DataColumn<T> extends ColumnType<T> {
  /** Явный отказ от сортировки: колонки действий и вложенных списков. */
  sortable?: boolean;
  /**
   * Значение для сортировки колонки, у которой нет `dataIndex`: маршрут,
   * составное наименование, координаты. Без него такая колонка осталась бы
   * несортируемой, хотя пользователю она ничем не отличается от прочих.
   */
  sortBy?: (row: T) => string | number | boolean | null | undefined;
  /** Наибольшая ширина при растягивании, px. */
  maxWidth?: number;
  /**
   * Фильтр колонки: по умолчанию — по значениям, если они подходят;
   * `false` — без фильтра; `'text'` — поиск по подстроке.
   */
  filterable?: boolean | 'text';
}

export type DataColumns<T> = DataColumn<T>[];

/** Минимальная форма колонки, с которой работает преобразование. */
interface RawColumn {
  key?: string | number;
  dataIndex?: string | number | readonly (string | number)[];
  width?: string | number;
  minWidth?: number;
  maxWidth?: number;
  sorter?: unknown;
  sortable?: boolean;
  sortBy?: (row: unknown) => string | number | boolean | null | undefined;
  filterable?: boolean | 'text';
  filters?: unknown;
  filterDropdown?: unknown;
  onFilter?: unknown;
  render?: (value: unknown, row: unknown, index: number) => ReactNode;
  [extra: string]: unknown;
}

const MIN_WIDTH = 80;
const MAX_WIDTH = 640;
/** Колонка без заданной ширины: уже — текст ломается по буквам. */
const FLEX_MIN_WIDTH = 140;
/** Больше вариантов — это уже не фильтр, а список; для него есть поиск. */
const MAX_FILTER_OPTIONS = 12;
const NUMERIC = /^-?\d+([.,]\d+)?$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}/;

/** Сравнение по значению поля: число, логическое, дата или строка. */
function compareValues(a: unknown, b: unknown): number {
  if (a === b) return 0;
  if (a === null || a === undefined) return -1;
  if (b === null || b === undefined) return 1;

  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'boolean' && typeof b === 'boolean') return Number(a) - Number(b);

  // Объект в ячейке сортировать нечем: строковое представление было бы
  // «[object Object]» и дало бы произвольный порядок. Такие колонки задают
  // свой `sorter` либо отказываются от сортировки через `sortable: false`.
  const left = asText(a);
  const right = asText(b);
  if (left === null || right === null) return 0;

  // Деньги и проценты приходят десятичной строкой (`CLAUDE.md § 3` п. 1).
  // Лексикографически «9» оказалось бы больше «10».
  if (NUMERIC.test(left.trim()) && NUMERIC.test(right.trim())) {
    return Number.parseFloat(left) - Number.parseFloat(right);
  }

  return left.localeCompare(right, 'ru');
}

/** Текст значения — только для примитивов, которые осмысленно сравнивать. */
function asText(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'bigint') return String(value);
  if (typeof value === 'boolean') return String(value);
  return null;
}

function readPath(row: unknown, path: readonly (string | number)[]): unknown {
  let value = row;
  for (const key of path) {
    if (value === null || value === undefined) return undefined;
    value = (value as Record<string | number, unknown>)[key];
  }
  return value;
}

/**
 * Значения колонки для фильтра: пары «значение — первая строка с ним».
 * `null` — колонка для фильтра по значениям не подходит.
 */
function filterOptions(
  rows: readonly unknown[],
  path: readonly (string | number)[],
): [string | boolean, unknown][] | null {
  const seen = new Map<string | boolean, unknown>();
  for (const row of rows) {
    const value = readPath(row, path);
    if (value === null || value === undefined) continue;
    // Суммы, даты и составные значения фильтруются не списком.
    if (typeof value === 'string') {
      if (value === '' || NUMERIC.test(value.trim()) || ISO_DATE.test(value)) return null;
    } else if (typeof value !== 'boolean') {
      return null;
    }
    if (!seen.has(value)) {
      seen.set(value, row);
      if (seen.size > MAX_FILTER_OPTIONS) return null;
    }
  }
  // Значение в каждой строке своё — это идентификатор, а не категория.
  if (seen.size < 2 || seen.size >= rows.length) return null;
  return [...seen.entries()];
}

/** Поиск по подстроке в выпадающем фильтре колонки. */
function TextFilter({
  setSelectedKeys,
  selectedKeys,
  confirm,
  clearFilters,
}: FilterDropdownProps): JSX.Element {
  const { t } = useTranslation();
  const value = typeof selectedKeys[0] === 'string' ? selectedKeys[0] : '';
  return (
    <div className="soc-table-filter">
      <Input
        autoFocus
        allowClear
        prefix={<SearchOutlined />}
        placeholder={t('table.searchPlaceholder')}
        value={value}
        onChange={(event) => {
          setSelectedKeys(event.target.value ? [event.target.value] : []);
        }}
        onPressEnter={() => {
          confirm();
        }}
      />
      <Space size={8}>
        <Button
          size="small"
          onClick={() => {
            clearFilters?.();
            confirm();
          }}
        >
          {t('table.resetFilter')}
        </Button>
        <Button
          size="small"
          type="primary"
          onClick={() => {
            confirm();
          }}
        >
          {t('table.applyFilter')}
        </Button>
      </Space>
    </div>
  );
}

/**
 * Начало перетаскивания: получает ячейку заголовка, возвращает обработчик
 * смещения указателя от точки, где жест начался.
 */
type ResizeStart = (cell: HTMLTableCellElement) => (offset: number) => void;

/** Заголовок с ручкой изменения ширины. */
function ResizableTitle(
  props: HTMLAttributes<HTMLTableCellElement> & {
    onResizeStart?: ResizeStart;
  },
): JSX.Element {
  const { onResizeStart, ...rest } = props;

  if (!onResizeStart) return <th {...rest} />;

  const handlePointerDown = (event: PointerEvent<HTMLSpanElement>): void => {
    event.preventDefault();
    event.stopPropagation();

    const handle = event.currentTarget;
    const cell = handle.closest('th');
    if (!cell) return;

    const originX = event.clientX;
    const resize = onResizeStart(cell);
    handle.setPointerCapture(event.pointerId);

    const move = (moveEvent: globalThis.PointerEvent): void => {
      resize(moveEvent.clientX - originX);
    };
    const end = (): void => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', end);
      handle.removeEventListener('pointercancel', end);
    };

    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
  };

  return (
    <th {...rest} style={{ ...rest.style, position: 'relative' }}>
      {rest.children}
      <span
        className="soc-resize-handle"
        role="separator"
        aria-orientation="vertical"
        onPointerDown={handlePointerDown}
        onClick={(event) => {
          // Клик по ручке не должен переключать сортировку колонки
          event.stopPropagation();
        }}
      />
    </th>
  );
}

const TABLE_COMPONENTS = { header: { cell: ResizableTitle } };
const EMPTY_ROWS: readonly unknown[] = [];
/** Колонка-заполнитель: занимает место справа, когда колонки уже таблицы. */
const FILLER_COLUMN: RawColumn = {
  key: '__filler',
  className: 'soc-table-filler',
  render: () => null,
};

function prepareColumns(
  columns: RawColumn[],
  widths: Record<string, number>,
  onResizeStart: (key: string, min: number, max: number) => ResizeStart,
  rows: readonly unknown[],
  serverPaged: boolean,
): RawColumn[] {
  return columns.map((column, index) => {
    const key =
      column.key !== undefined
        ? String(column.key)
        : column.dataIndex !== undefined
          ? String(column.dataIndex)
          : `col_${String(index)}`;

    const declared = typeof column.width === 'number' ? column.width : undefined;
    const width = widths[key] ?? declared;

    const { sortable, sortBy, maxWidth, filterable, ...rest } = column;
    const next: RawColumn = { ...rest };
    const min = column.minWidth ?? MIN_WIDTH;
    const max = maxWidth ?? MAX_WIDTH;

    if (width !== undefined) next['width'] = width;
    if (width === undefined && column.minWidth === undefined) next['minWidth'] = FLEX_MIN_WIDTH;

    const path =
      column.dataIndex === undefined
        ? null
        : Array.isArray(column.dataIndex)
          ? (column.dataIndex as readonly (string | number)[])
          : [column.dataIndex as string | number];

    if (column.sorter === undefined && sortable !== false) {
      if (sortBy) {
        next['sorter'] = (a: unknown, b: unknown): number => compareValues(sortBy(a), sortBy(b));
        next['showSorterTooltip'] = false;
      } else if (path) {
        next['sorter'] = (a: unknown, b: unknown): number =>
          compareValues(readPath(a, path), readPath(b, path));
        next['showSorterTooltip'] = false;
      }
    }

    const ownFilter =
      column.filters !== undefined ||
      column.filterDropdown !== undefined ||
      column.onFilter !== undefined;

    if (path && !ownFilter && !serverPaged && filterable !== false) {
      if (filterable === 'text') {
        next['filterDropdown'] = (props: FilterDropdownProps) => <TextFilter {...props} />;
        next['filterIcon'] = (active: boolean) => (
          <SearchOutlined className={active ? 'soc-filter-icon is-active' : 'soc-filter-icon'} />
        );
        next['onFilter'] = (value: unknown, row: unknown): boolean =>
          (asText(readPath(row, path)) ?? '').toLowerCase().includes(String(value).toLowerCase());
      } else {
        const options = filterOptions(rows, path);
        if (options) {
          const render = column.render;
          next['filters'] = options.map(([value, row]) => ({
            value,
            text: render ? render(value, row, 0) : String(value),
          }));
          next['onFilter'] = (value: unknown, row: unknown): boolean =>
            readPath(row, path) === value;
        }
      }
    }

    next['onHeaderCell'] = () => ({
      'data-col-key': key,
      onResizeStart: onResizeStart(key, min, max),
    });

    return next;
  });
}

/**
 * Колонка-заполнитель встаёт перед закреплёнными справа: закреплённые
 * колонки обязаны быть крайними, иначе таблица не прижмёт их к краю.
 */
function withFiller(columns: RawColumn[]): RawColumn[] {
  let at = columns.length;
  while (at > 0 && columns[at - 1]?.['fixed'] === 'right') at -= 1;
  return [...columns.slice(0, at), FILLER_COLUMN, ...columns.slice(at)];
}

export function DataTable<T extends object>({
  columns,
  ...rest
}: Omit<TableProps<T>, 'columns' | 'components'> & { columns: DataColumns<T> }): JSX.Element {
  // Ширина колонок после первого перетаскивания: ключ колонки → пиксели.
  // Пустой объект — раскладка ещё не заморожена.
  const [widths, setWidths] = useState<Record<string, number>>({});
  const frozen = Object.keys(widths).length > 0;

  const rows = rest.dataSource ?? EMPTY_ROWS;
  // Серверная разбивка: таблица знает общее число строк, а видит одну страницу.
  const serverPaged = typeof rest.pagination === 'object' && rest.pagination.total !== undefined;

  const prepared = useMemo(() => {
    const onResizeStart =
      (key: string, min: number, max: number): ResizeStart =>
      (cell) => {
        // Замораживаются все колонки строки заголовка: иначе браузер
        // перераспределит место между ними, пока тянут одну.
        const measured: Record<string, number> = {};
        cell.parentElement
          ?.querySelectorAll<HTMLTableCellElement>('th[data-col-key]')
          .forEach((th) => {
            const thKey = th.dataset['colKey'];
            if (thKey) measured[thKey] = Math.round(th.getBoundingClientRect().width);
          });
        setWidths(measured);

        const start = measured[key] ?? Math.round(cell.getBoundingClientRect().width);
        // Колонка, уже выходящая за пределы, не прыгает к ним с первым движением.
        const lower = Math.min(min, start);
        const upper = Math.max(max, start);
        return (offset) => {
          setWidths((current) => ({
            ...current,
            [key]: Math.min(upper, Math.max(lower, start + offset)),
          }));
        };
      };

    const columnsWithWidths = prepareColumns(
      columns as unknown as RawColumn[],
      widths,
      onResizeStart,
      rows,
      serverPaged,
    );
    return frozen ? withFiller(columnsWithWidths) : columnsWithWidths;
  }, [columns, widths, frozen, rows, serverPaged]);

  // Замороженная раскладка — фиксированная: заданная ширина для браузера
  // закон, а не подсказка. Ширина прокрутки — сумма колонок, иначе таблица
  // не станет шире карточки.
  const scroll = frozen
    ? {
        ...rest.scroll,
        x: prepared.reduce(
          (sum, column) => sum + (typeof column.width === 'number' ? column.width : 0),
          0,
        ),
      }
    : rest.scroll;

  return (
    <Table<T>
      {...rest}
      {...(frozen ? { tableLayout: rest.tableLayout ?? 'fixed' } : {})}
      {...(scroll ? { scroll } : {})}
      columns={prepared as unknown as TableProps<T>['columns']}
      components={TABLE_COMPONENTS}
    />
  );
}
