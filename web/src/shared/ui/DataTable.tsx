import { useMemo, useRef, useState, type HTMLAttributes, type JSX, type PointerEvent } from 'react';
import { Table } from 'antd';
import type { ColumnType, TableProps } from 'antd/es/table';

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
}

export type DataColumns<T> = DataColumn<T>[];

/** Минимальная форма колонки, с которой работает преобразование. */
interface RawColumn {
  key?: string | number;
  dataIndex?: string | number | readonly (string | number)[];
  width?: string | number;
  sorter?: unknown;
  sortable?: boolean;
  sortBy?: (row: unknown) => string | number | boolean | null | undefined;
  [extra: string]: unknown;
}

const MIN_WIDTH = 60;
const NUMERIC = /^-?\d+([.,]\d+)?$/;

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

/** Заголовок с ручкой изменения ширины. */
function ResizableTitle(
  props: HTMLAttributes<HTMLTableCellElement> & {
    onResize?: (delta: number) => void;
  },
): JSX.Element {
  const { onResize, ...rest } = props;
  const startX = useRef(0);

  if (!onResize) return <th {...rest} />;

  const handlePointerDown = (event: PointerEvent<HTMLSpanElement>): void => {
    event.preventDefault();
    event.stopPropagation();
    startX.current = event.clientX;

    const handle = event.currentTarget;
    handle.setPointerCapture(event.pointerId);

    const move = (moveEvent: globalThis.PointerEvent): void => {
      onResize(moveEvent.clientX - startX.current);
      startX.current = moveEvent.clientX;
    };
    const up = (): void => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
    };

    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
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

function prepareColumns(
  columns: RawColumn[],
  widths: Record<string, number>,
  onResize: (key: string, base: number, delta: number) => void,
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

    const { sortable, sortBy, ...rest } = column;
    const next: RawColumn = { ...rest };

    if (width !== undefined) next['width'] = width;

    if (column.sorter === undefined && sortable !== false) {
      if (sortBy) {
        next['sorter'] = (a: unknown, b: unknown): number => compareValues(sortBy(a), sortBy(b));
        next['showSorterTooltip'] = false;
      } else if (column.dataIndex !== undefined) {
        const path = Array.isArray(column.dataIndex)
          ? (column.dataIndex as readonly (string | number)[])
          : [column.dataIndex as string | number];
        next['sorter'] = (a: unknown, b: unknown): number =>
          compareValues(readPath(a, path), readPath(b, path));
        next['showSorterTooltip'] = false;
      }
    }

    if (width !== undefined) {
      next['onHeaderCell'] = () => ({
        onResize: (delta: number) => {
          onResize(key, width, delta);
        },
      });
    }

    return next;
  });
}

export function DataTable<T extends object>({
  columns,
  ...rest
}: Omit<TableProps<T>, 'columns' | 'components'> & { columns: DataColumns<T> }): JSX.Element {
  // Ширина, изменённая пользователем: ключ колонки → пиксели
  const [widths, setWidths] = useState<Record<string, number>>({});

  const prepared = useMemo(
    () =>
      prepareColumns(columns as unknown as RawColumn[], widths, (key, base, delta) => {
        setWidths((current) => ({
          ...current,
          [key]: Math.max(MIN_WIDTH, (current[key] ?? base) + delta),
        }));
      }),
    [columns, widths],
  );

  return (
    <Table<T>
      {...rest}
      columns={prepared as unknown as TableProps<T>['columns']}
      components={TABLE_COMPONENTS}
    />
  );
}
