import { Injectable } from '@angular/core';
import {
  CellValue,
  CrosstabColumnGroup,
  CrosstabDefinition,
  CrosstabFooterRow,
  CrosstabMatrix,
  CrosstabMatrixRow,
  CrosstabValueDefinition,
  DataRecord,
  DataSourceField,
} from '../models/report-definition.model';

interface Bucket {
  readonly count: number;
  readonly sum: number;
  readonly min: number | null;
  readonly max: number | null;
}

interface RowAccumulator {
  readonly labels: readonly string[];
  readonly cells: ReadonlyMap<string, ReadonlyMap<string, Bucket>>;
  readonly totals: ReadonlyMap<string, Bucket>;
}

interface ColumnAccumulator {
  readonly label: string;
  readonly totals: ReadonlyMap<string, Bucket>;
}

const emptyBucket: Bucket = {
  count: 0,
  sum: 0,
  min: null,
  max: null,
};

@Injectable({ providedIn: 'root' })
export class CrosstabEngineService {
  createMatrix(
    records: readonly DataRecord[],
    definition: CrosstabDefinition,
    fieldLookup: ReadonlyMap<string, DataSourceField>,
  ): CrosstabMatrix {
    const rowFields = definition.rowFieldIds
      .map((fieldId) => fieldLookup.get(fieldId))
      .filter((field): field is DataSourceField => field !== undefined);
    const columnFields = definition.columnFieldIds
      .map((fieldId) => fieldLookup.get(fieldId))
      .filter((field): field is DataSourceField => field !== undefined);
    const rows = new Map<string, RowAccumulator>();
    const columns = new Map<string, ColumnAccumulator>();
    const grandTotals = new Map<string, Bucket>();

    for (const record of records) {
      const rowKey = this.createKey(rowFields, record);
      const columnKey = this.createKey(columnFields, record);
      const rowLabels = this.createLabels(rowFields, record);
      const columnLabel = this.createLabel(columnFields, record);
      const row = this.ensureRow(rows, rowKey, rowLabels);
      const column = this.ensureColumn(columns, columnKey, columnLabel);

      for (const valueDefinition of definition.values) {
        const rawValue = record[valueDefinition.fieldId];
        this.updateNestedBucket(row.cells, columnKey, valueDefinition.id, rawValue);
        this.updateBucketMap(row.totals, valueDefinition.id, rawValue);
        this.updateBucketMap(column.totals, valueDefinition.id, rawValue);
        this.updateBucketMap(grandTotals, valueDefinition.id, rawValue);
      }
    }

    const columnGroups = this.createColumnGroups(columns, definition.values);
    const matrixRows = [...rows.entries()].map(([key, row]) =>
      this.createMatrixRow(key, row, columnGroups, definition.values),
    );
    const footerRows = definition.includeColumnTotals
      ? [this.createFooterRow(columns, columnGroups, definition.values, grandTotals)]
      : [];

    return {
      rowFields,
      columnFields,
      valueDefinitions: definition.values,
      columnGroups,
      rows: matrixRows,
      footerRows,
    };
  }

  private createColumnGroups(
    columns: ReadonlyMap<string, ColumnAccumulator>,
    values: readonly CrosstabValueDefinition[],
  ): readonly CrosstabColumnGroup[] {
    return [...columns.entries()].map(([key, column]) => ({
      key,
      label: column.label,
      values: values.map((value) => ({
        key: `${key}::${value.id}`,
        columnKey: key,
        valueId: value.id,
        label: `${value.aggregation.toUpperCase()} ${value.label}`,
      })),
    }));
  }

  private createMatrixRow(
    key: string,
    row: RowAccumulator,
    columnGroups: readonly CrosstabColumnGroup[],
    values: readonly CrosstabValueDefinition[],
  ): CrosstabMatrixRow {
    const cells: Record<string, number> = {};
    const totalCells: Record<string, number> = {};

    for (const columnGroup of columnGroups) {
      for (const valueColumn of columnGroup.values) {
        const bucket = row.cells.get(columnGroup.key)?.get(valueColumn.valueId) ?? emptyBucket;
        const value = values.find((definition) => definition.id === valueColumn.valueId);
        cells[valueColumn.key] = value ? this.readBucket(bucket, value) : 0;
      }
    }

    for (const value of values) {
      totalCells[value.id] = this.readBucket(row.totals.get(value.id) ?? emptyBucket, value);
    }

    return {
      key,
      labels: row.labels,
      cells,
      totalCells,
    };
  }

  private createFooterRow(
    columns: ReadonlyMap<string, ColumnAccumulator>,
    columnGroups: readonly CrosstabColumnGroup[],
    values: readonly CrosstabValueDefinition[],
    grandTotals: ReadonlyMap<string, Bucket>,
  ): CrosstabFooterRow {
    const cells: Record<string, number> = {};
    const totalCells: Record<string, number> = {};

    for (const columnGroup of columnGroups) {
      const column = columns.get(columnGroup.key);

      for (const valueColumn of columnGroup.values) {
        const value = values.find((definition) => definition.id === valueColumn.valueId);
        const bucket = column?.totals.get(valueColumn.valueId) ?? emptyBucket;
        cells[valueColumn.key] = value ? this.readBucket(bucket, value) : 0;
      }
    }

    for (const value of values) {
      totalCells[value.id] = this.readBucket(grandTotals.get(value.id) ?? emptyBucket, value);
    }

    return {
      labels: ['Column total'],
      cells,
      totalCells,
    };
  }

  private ensureRow(
    rows: Map<string, RowAccumulator>,
    key: string,
    labels: readonly string[],
  ): RowAccumulator {
    const existing = rows.get(key);

    if (existing) {
      return existing;
    }

    const row: RowAccumulator = {
      labels,
      cells: new Map<string, Map<string, Bucket>>(),
      totals: new Map<string, Bucket>(),
    };
    rows.set(key, row);

    return row;
  }

  private ensureColumn(
    columns: Map<string, ColumnAccumulator>,
    key: string,
    label: string,
  ): ColumnAccumulator {
    const existing = columns.get(key);

    if (existing) {
      return existing;
    }

    const column: ColumnAccumulator = {
      label,
      totals: new Map<string, Bucket>(),
    };
    columns.set(key, column);

    return column;
  }

  private updateNestedBucket(
    cells: ReadonlyMap<string, ReadonlyMap<string, Bucket>>,
    columnKey: string,
    valueId: string,
    value: CellValue,
  ): void {
    const mutableCells = cells as Map<string, Map<string, Bucket>>;
    const columnBuckets = mutableCells.get(columnKey) ?? new Map<string, Bucket>();
    mutableCells.set(columnKey, columnBuckets);
    this.updateBucketMap(columnBuckets, valueId, value);
  }

  private updateBucketMap(
    buckets: ReadonlyMap<string, Bucket>,
    key: string,
    value: CellValue,
  ): void {
    const mutableBuckets = buckets as Map<string, Bucket>;
    const nextBucket = this.addValue(mutableBuckets.get(key) ?? emptyBucket, value);
    mutableBuckets.set(key, nextBucket);
  }

  private addValue(bucket: Bucket, value: CellValue): Bucket {
    const numericValue = typeof value === 'number' ? value : null;
    const count = value === null || value === '' ? bucket.count : bucket.count + 1;
    const sum = numericValue === null ? bucket.sum : bucket.sum + numericValue;
    const min =
      numericValue === null
        ? bucket.min
        : bucket.min === null
          ? numericValue
          : Math.min(bucket.min, numericValue);
    const max =
      numericValue === null
        ? bucket.max
        : bucket.max === null
          ? numericValue
          : Math.max(bucket.max, numericValue);

    return {
      count,
      sum,
      min,
      max,
    };
  }

  private readBucket(bucket: Bucket, valueDefinition: CrosstabValueDefinition): number {
    switch (valueDefinition.aggregation) {
      case 'avg':
        return bucket.count === 0 ? 0 : bucket.sum / bucket.count;
      case 'min':
        return bucket.min ?? 0;
      case 'max':
        return bucket.max ?? 0;
      case 'sum':
        return bucket.sum;
      case 'count':
        return bucket.count;
    }
  }

  private createKey(fields: readonly DataSourceField[], record: DataRecord): string {
    if (fields.length === 0) {
      return 'all';
    }

    return fields.map((field) => String(record[field.id] ?? 'Blank')).join('||');
  }

  private createLabels(fields: readonly DataSourceField[], record: DataRecord): readonly string[] {
    if (fields.length === 0) {
      return ['All'];
    }

    return fields.map((field) => String(record[field.id] ?? 'Blank'));
  }

  private createLabel(fields: readonly DataSourceField[], record: DataRecord): string {
    return this.createLabels(fields, record).join(' / ');
  }
}
