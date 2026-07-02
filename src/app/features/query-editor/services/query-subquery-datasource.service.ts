import { Injectable } from '@angular/core';
import { DataSourceField, DataSourceTable, QuerySubquery } from '../models/report-definition.model';
import { createSafeSqlAlias } from './query-crosstab-config.service';

@Injectable({ providedIn: 'root' })
export class QuerySubqueryDatasourceService {
  createTable(
    subquery: QuerySubquery,
    baseFieldLookup: ReadonlyMap<string, DataSourceField>,
  ): DataSourceTable {
    const tableId = createSubqueryTableId(subquery.id);
    const fields = subquery.query.columns
      .filter((column) => column.visible)
      .map((column, index) => {
        const sourceField = baseFieldLookup.get(column.fieldId);
        const fieldName = createSafeSqlAlias(
          column.alias || sourceField?.name || `Column${index + 1}`,
        );

        return {
          id: `${tableId}.${fieldName}`,
          tableId,
          name: fieldName,
          label: column.alias || sourceField?.label || fieldName,
          expression: `${subquery.alias}.${fieldName}`,
          type: sourceField?.type ?? 'string',
          nullable: sourceField?.nullable ?? true,
          aggregations: sourceField?.aggregations ?? (['count'] as const),
        };
      });

    return {
      id: tableId,
      schema: 'subquery',
      name: subquery.name,
      alias: subquery.alias,
      label: subquery.name,
      sourceType: 'subquery',
      subqueryId: subquery.id,
      fields,
    };
  }

  createTableId(subqueryId: string): string {
    return createSubqueryTableId(subqueryId);
  }

  parseTableId(tableId: string): string | null {
    return parseSubqueryTableId(tableId);
  }
}

export function createSubqueryTableId(subqueryId: string): string {
  return `subquery:${subqueryId}`;
}

export function parseSubqueryTableId(tableId: string): string | null {
  return tableId.startsWith('subquery:') ? tableId.slice('subquery:'.length) : null;
}
