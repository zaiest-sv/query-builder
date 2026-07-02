import { Injectable } from '@angular/core';
import {
  CrosstabDefinition,
  DataSourceField,
  QueryColumn,
} from '../models/report-definition.model';

@Injectable({ providedIn: 'root' })
export class QueryCrosstabConfigService {
  createOutputFields(
    columns: readonly QueryColumn[],
    fieldLookup: ReadonlyMap<string, DataSourceField>,
  ): readonly DataSourceField[] {
    return columns.map((column) => {
      const sourceField = fieldLookup.get(column.fieldId);
      const name = createSafeSqlAlias(column.alias || sourceField?.name || column.id);

      return {
        id: column.id,
        tableId: 'query-output',
        name: name || column.id,
        label: column.alias || sourceField?.label || column.id,
        expression: column.expression,
        type: sourceField?.type ?? 'string',
        nullable: sourceField?.nullable ?? true,
        aggregations: sourceField?.aggregations ?? (['count'] as const),
      };
    });
  }

  normalizeDefinition(
    definition: CrosstabDefinition,
    columns: readonly QueryColumn[],
  ): CrosstabDefinition {
    return {
      ...definition,
      rowFieldIds: this.normalizeFieldIds(definition.rowFieldIds, columns),
      columnFieldIds: this.normalizeFieldIds(definition.columnFieldIds, columns),
      values: definition.values.map((value) => ({
        ...value,
        fieldId: this.normalizeFieldId(value.fieldId, columns),
      })),
    };
  }

  normalizeFieldIds(
    fieldIds: readonly string[],
    columns: readonly QueryColumn[],
  ): readonly string[] {
    return fieldIds.map((fieldId) => this.normalizeFieldId(fieldId, columns));
  }

  normalizeFieldId(fieldId: string, columns: readonly QueryColumn[]): string {
    return columns.find((column) => column.fieldId === fieldId)?.id ?? fieldId;
  }

  createEquivalentFieldIds(fieldId: string, columns: readonly QueryColumn[]): ReadonlySet<string> {
    const fieldIds = new Set<string>([fieldId]);
    const column = columns.find(
      (currentColumn) => currentColumn.id === fieldId || currentColumn.fieldId === fieldId,
    );

    if (column) {
      fieldIds.add(column.id);
      fieldIds.add(column.fieldId);
    }

    return fieldIds;
  }

  createRenderableDefinition(
    definition: CrosstabDefinition,
    fieldLookup: ReadonlyMap<string, DataSourceField>,
  ): CrosstabDefinition {
    const valueKeys = new Set<string>();

    return {
      ...definition,
      rowFieldIds: definition.rowFieldIds.filter((fieldId) => fieldLookup.has(fieldId)),
      columnFieldIds: definition.columnFieldIds.filter((fieldId) => fieldLookup.has(fieldId)),
      values: definition.values.filter((value) => {
        const field = fieldLookup.get(value.fieldId);
        const valueKey = `${value.fieldId}:${value.aggregation}`;

        if (!field || !field.aggregations.includes(value.aggregation) || valueKeys.has(valueKey)) {
          return false;
        }

        valueKeys.add(valueKey);

        return true;
      }),
    };
  }

  createConfigIssues(
    definition: CrosstabDefinition,
    fieldLookup: ReadonlyMap<string, DataSourceField>,
  ): readonly string[] {
    const issues: string[] = [];
    const valueKeys = new Set<string>();

    if (fieldLookup.size === 0) {
      issues.push('Add at least one visible Main query column.');
    }

    if (definition.rowFieldIds.length === 0) {
      issues.push('Add at least one row field.');
    }

    if (definition.columnFieldIds.length === 0) {
      issues.push('Add at least one column field.');
    }

    if (definition.values.length === 0) {
      issues.push('Add at least one value.');
    }

    for (const fieldId of [...definition.rowFieldIds, ...definition.columnFieldIds]) {
      if (!fieldLookup.has(fieldId)) {
        issues.push(`${fieldId} is not available in Main query output.`);
      }
    }

    for (const value of definition.values) {
      const field = fieldLookup.get(value.fieldId);
      const valueKey = `${value.fieldId}:${value.aggregation}`;

      if (!field) {
        issues.push(`${value.label} is not available in Main query output.`);
      } else if (!field.aggregations.includes(value.aggregation)) {
        issues.push(`${value.aggregation.toUpperCase()} is not supported for ${field.label}.`);
      }

      if (valueKeys.has(valueKey)) {
        issues.push(`${value.aggregation.toUpperCase()} ${value.label} is duplicated.`);
      } else {
        valueKeys.add(valueKey);
      }
    }

    return issues;
  }
}

export function createSafeSqlAlias(value: string): string {
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
