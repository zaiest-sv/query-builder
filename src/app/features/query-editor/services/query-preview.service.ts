import { Injectable } from '@angular/core';
import {
  CellValue,
  DataRecord,
  DataSourceField,
  PreviewRow,
  QueryColumn,
  QueryFilter,
  QueryParameter,
  ReportDefinition,
} from '../models/report-definition.model';
import { createSubqueryTableId } from './query-subquery-datasource.service';

@Injectable({ providedIn: 'root' })
export class QueryPreviewService {
  createDataRows(
    rows: readonly DataRecord[],
    report: ReportDefinition,
    baseFieldLookup: ReadonlyMap<string, DataSourceField>,
  ): readonly DataRecord[] {
    const previewRows = rows.map((row) => ({ ...row }));

    for (const subquery of report.subqueries) {
      const tableId = createSubqueryTableId(subquery.id);

      subquery.query.columns
        .filter((column) => column.visible)
        .forEach((column, index) => {
          const sourceField = baseFieldLookup.get(column.fieldId);
          const fieldName = createSafeSqlAlias(
            column.alias || sourceField?.name || `Column${index + 1}`,
          );
          const subqueryFieldId = `${tableId}.${fieldName}`;

          previewRows.forEach((row) => {
            row[subqueryFieldId] = row[column.fieldId] ?? null;
          });
        });
    }

    return previewRows;
  }

  applyPromptFilters(
    rows: readonly DataRecord[],
    filters: readonly QueryFilter[],
    parameters: readonly QueryParameter[],
    parameterValues: Readonly<Record<string, string>> = {},
  ): readonly DataRecord[] {
    const parameterLookup = new Map(parameters.map((parameter) => [parameter.name, parameter]));

    return rows.filter((row) =>
      filters.every((filter) => {
        const value = row[filter.fieldId];
        const filterValue =
          filter.operator === 'isEmpty' || filter.operator === 'isNull'
            ? ''
            : (parameterValues[filter.parameterName] ??
              parameterLookup.get(filter.parameterName)?.defaultValue ??
              filter.value);
        const filterValueTo = filter.valueTo ?? '';
        let matches = false;

        switch (filter.operator) {
          case 'equals':
            matches = String(value ?? '').toLowerCase() === filterValue.toLowerCase();
            break;
          case 'notEquals':
            matches = String(value ?? '').toLowerCase() !== filterValue.toLowerCase();
            break;
          case 'contains':
            matches = String(value ?? '')
              .toLowerCase()
              .includes(filterValue.toLowerCase());
            break;
          case 'startsWith':
            matches = String(value ?? '').toLowerCase().startsWith(filterValue.toLowerCase());
            break;
          case 'endsWith':
            matches = String(value ?? '').toLowerCase().endsWith(filterValue.toLowerCase());
            break;
          case 'greaterThan':
            matches = Number(value) > Number(filterValue);
            break;
          case 'greaterThanOrEquals':
            matches = Number(value) >= Number(filterValue);
            break;
          case 'lessThan':
            matches = Number(value) < Number(filterValue);
            break;
          case 'lessThanOrEquals':
            matches = Number(value) <= Number(filterValue);
            break;
          case 'isEmpty':
            matches = value === null || value === '';
            break;
          case 'isNull':
            matches = value === null;
            break;
          case 'between':
            matches =
              compareCellValues(value, filterValue) >= 0 &&
              compareCellValues(value, filterValueTo) <= 0;
            break;
        }

        return filter.negate ? !matches : matches;
      }),
    );
  }

  applyColumnCriteria(
    rows: readonly DataRecord[],
    columns: readonly QueryColumn[],
  ): readonly DataRecord[] {
    const criteriaColumns = columns.filter((column) =>
      [column.criteria, ...(column.orCriteria ?? [])].some((criteria) => criteria?.trim()),
    );

    if (criteriaColumns.length === 0) {
      return rows;
    }

    return rows.filter((row) =>
      criteriaColumns.every((column) => {
        const criteriaValues = [column.criteria, ...(column.orCriteria ?? [])].filter(
          (criteria): criteria is string => Boolean(criteria?.trim()),
        );

        return criteriaValues.some((criteria) =>
          matchesColumnCriteria(row[column.fieldId], criteria),
        );
      }),
    );
  }

  sortRows(rows: readonly DataRecord[], columns: readonly QueryColumn[]): readonly DataRecord[] {
    const sortColumns = columns.filter((column) => column.sortDirection !== 'none');

    if (sortColumns.length === 0) {
      return rows;
    }

    return [...rows].sort((firstRow, secondRow) => {
      for (const column of sortColumns) {
        const comparison = compareCellValues(
          firstRow[column.fieldId] ?? null,
          secondRow[column.fieldId] ?? null,
        );

        if (comparison !== 0) {
          return column.sortDirection === 'asc' ? comparison : -comparison;
        }
      }

      return 0;
    });
  }

  projectRows(rows: readonly DataRecord[], columns: readonly QueryColumn[]): readonly PreviewRow[] {
    return rows.map((row) => ({
      id: row.id,
      cells: Object.fromEntries(columns.map((column) => [column.id, row[column.fieldId] ?? null])),
    }));
  }
}

function matchesColumnCriteria(value: CellValue, criteria: string): boolean {
  const trimmedCriteria = criteria.trim();

  if (!trimmedCriteria) {
    return true;
  }

  const operatorMatch = /^(>=|<=|<>|!=|=|>|<)\s*(.+)$/.exec(trimmedCriteria);

  if (operatorMatch) {
    const operator = operatorMatch[1] === '!=' ? '<>' : operatorMatch[1];
    const criteriaValue = operatorMatch[2] ?? '';
    const comparison = compareCellValues(value, criteriaValue);

    switch (operator) {
      case '=':
        return comparison === 0;
      case '<>':
        return comparison !== 0;
      case '>':
        return comparison > 0;
      case '>=':
        return comparison >= 0;
      case '<':
        return comparison < 0;
      case '<=':
        return comparison <= 0;
      default:
        return false;
    }
  }

  if (trimmedCriteria.includes('%')) {
    return createWildcardMatcher(trimmedCriteria).test(String(value ?? ''));
  }

  return compareCellValues(value, trimmedCriteria) === 0;
}

function compareCellValues(firstValue: CellValue, secondValue: CellValue): number {
  if (firstValue === secondValue) {
    return 0;
  }

  if (firstValue === null || firstValue === '') {
    return -1;
  }

  if (secondValue === null || secondValue === '') {
    return 1;
  }

  const firstNumber = Number(firstValue);
  const secondNumber = Number(secondValue);

  if (Number.isFinite(firstNumber) && Number.isFinite(secondNumber)) {
    return firstNumber - secondNumber;
  }

  const firstTime = typeof firstValue === 'string' ? Date.parse(firstValue) : Number.NaN;
  const secondTime = typeof secondValue === 'string' ? Date.parse(secondValue) : Number.NaN;

  if (Number.isFinite(firstTime) && Number.isFinite(secondTime)) {
    return firstTime - secondTime;
  }

  return String(firstValue).localeCompare(String(secondValue), undefined, {
    numeric: true,
    sensitivity: 'base',
  });
}

function createWildcardMatcher(pattern: string): RegExp {
  const escapedPattern = pattern
    .split('%')
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');

  return new RegExp(`^${escapedPattern}$`, 'i');
}

function createSafeSqlAlias(value: string): string {
  const normalized = value
    .trim()
    .replace(/[^A-Za-z0-9_]/g, '_')
    .replace(/_+/g, '_');
  const withoutEdgeUnderscores = normalized.replace(/^_+|_+$/g, '');

  if (!withoutEdgeUnderscores) {
    return '';
  }

  return /^[A-Za-z]/.test(withoutEdgeUnderscores)
    ? withoutEdgeUnderscores
    : `Alias_${withoutEdgeUnderscores}`;
}
