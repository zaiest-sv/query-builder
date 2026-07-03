import { Injectable } from '@angular/core';
import {
  CellValue,
  DataSourceField,
  DataSourceTable,
  FieldType,
  FilterOperator,
  QueryJoin,
  QueryJoinCondition,
  QueryJoinOperator,
  QueryJoinType,
  QueryDocument,
  ReportDefinition,
} from '../models/report-definition.model';
import { findConflictingJoinPairIds } from './query-join-graph.service';

const operatorLabels: Readonly<Record<Exclude<FilterOperator, 'contains' | 'isEmpty'>, string>> = {
  equals: '=',
  notEquals: '<>',
  greaterThan: '>',
  lessThan: '<',
};

const joinOperatorLabels: Readonly<Record<QueryJoinOperator, string>> = {
  equals: '=',
  notEquals: '<>',
  greaterThan: '>',
  greaterThanOrEquals: '>=',
  lessThan: '<',
  lessThanOrEquals: '<=',
};

@Injectable({ providedIn: 'root' })
export class QuerySqlBuilderService {
  build(
    report: ReportDefinition,
    tableLookup: ReadonlyMap<string, DataSourceTable>,
    fieldLookup: ReadonlyMap<string, DataSourceField>,
  ): string {
    return this.buildQuery(report.query, report, tableLookup, fieldLookup);
  }

  buildQuery(
    query: QueryDocument,
    report: ReportDefinition,
    tableLookup: ReadonlyMap<string, DataSourceTable>,
    fieldLookup: ReadonlyMap<string, DataSourceField>,
    visitedSubqueryIds: ReadonlySet<string> = new Set(),
  ): string {
    const selectedColumns = query.columns.filter((column) => column.visible);
    const selectLines =
      selectedColumns.length === 0
        ? ['  *']
        : selectedColumns.map((column) => {
            const field = fieldLookup.get(column.fieldId);
            const expression = field
              ? this.createColumnExpression(column.expression, field, tableLookup)
              : column.expression;

            return `  ${expression} AS ${quoteIdentifier(column.alias)}`;
          });
    const tables = query.sourceTableIds
      .map((tableId) => tableLookup.get(tableId))
      .filter((table): table is DataSourceTable => table !== undefined);
    const primaryTable = tables[0];
    const fromLine = primaryTable
      ? `FROM ${this.createTableExpression(
          primaryTable,
          report,
          tableLookup,
          fieldLookup,
          visitedSubqueryIds,
        )}`
      : 'FROM <select a datasource>';
    const joinLines = primaryTable
      ? this.createJoinLines(
          tables,
          query.joins,
          report,
          tableLookup,
          fieldLookup,
          visitedSubqueryIds,
        )
      : [];
    const whereLines = query.filters.map((filter) => {
      const field = fieldLookup.get(filter.fieldId);
      const expression = field ? this.createFieldExpression(field, tableLookup) : filter.fieldId;
      const value = filter.parameterName
        ? formatParameterName(filter.parameterName)
        : formatSqlValue(filter.value, field?.type ?? 'string');

      if (filter.operator === 'isEmpty') {
        return `  (${expression} IS NULL OR ${expression} = '')`;
      }

      if (filter.operator === 'contains') {
        return `  ${expression} LIKE '%' + ${value} + '%'`;
      }

      return `  ${expression} ${operatorLabels[filter.operator]} ${value}`;
    });
    const columnCriteriaLines = query.columns
      .map((column) => {
        const field = fieldLookup.get(column.fieldId);
        const expression = field
          ? this.createColumnExpression(column.expression, field, tableLookup)
          : column.expression;
        const criteria = [column.criteria, ...(column.orCriteria ?? [])]
          .map((value) =>
            createCriteriaExpression(expression, value ?? '', field?.type ?? 'string'),
          )
          .filter((value): value is string => value !== null);

        if (criteria.length === 0) {
          return null;
        }

        return criteria.length === 1 ? `  ${criteria[0]}` : `  (${criteria.join(' OR ')})`;
      })
      .filter((value): value is string => value !== null);
    const groupByLines = query.columns
      .filter((column) => column.groupBy === true)
      .map((column) => {
        const field = fieldLookup.get(column.fieldId);

        return field
          ? this.createColumnExpression(column.expression, field, tableLookup)
          : column.expression;
      });
    const orderLines = query.columns
      .filter((column) => column.sortDirection !== 'none')
      .map((column) => `${quoteIdentifier(column.alias)} ${column.sortDirection.toUpperCase()}`);

    return [
      'SELECT',
      selectLines.join(',\n'),
      fromLine,
      ...joinLines,
      ...(whereLines.length + columnCriteriaLines.length > 0
        ? ['WHERE', [...whereLines, ...columnCriteriaLines].join('\n  AND')]
        : []),
      ...(groupByLines.length > 0 ? [`GROUP BY ${groupByLines.join(', ')}`] : []),
      ...(orderLines.length > 0 ? [`ORDER BY ${orderLines.join(', ')}`] : []),
    ].join('\n');
  }

  private createTableExpression(
    table: DataSourceTable,
    report: ReportDefinition,
    tableLookup: ReadonlyMap<string, DataSourceTable>,
    fieldLookup: ReadonlyMap<string, DataSourceField>,
    visitedSubqueryIds: ReadonlySet<string>,
  ): string {
    if (table.sourceType === 'subquery' && table.subqueryId) {
      if (visitedSubqueryIds.has(table.subqueryId)) {
        return `(\n  SELECT NULL AS [CircularDependency]\n) AS ${quoteIdentifier(table.alias)}`;
      }

      const subquery = report.subqueries.find(
        (currentSubquery) => currentSubquery.id === table.subqueryId,
      );

      if (subquery) {
        const nextVisitedSubqueryIds = new Set(visitedSubqueryIds);
        nextVisitedSubqueryIds.add(subquery.id);
        const subquerySql = this.buildQuery(
          subquery.query,
          {
            ...report,
            subqueries: report.subqueries.filter(
              (currentSubquery) => currentSubquery.id !== subquery.id,
            ),
          },
          tableLookup,
          fieldLookup,
          nextVisitedSubqueryIds,
        )
          .split('\n')
          .map((line) => `  ${line}`)
          .join('\n');

        return `(\n${subquerySql}\n) AS ${quoteIdentifier(table.alias)}`;
      }
    }

    return `${quoteIdentifier(table.schema)}.${quoteIdentifier(table.name)} AS ${quoteIdentifier(table.alias)}`;
  }

  private createFieldExpression(
    field: DataSourceField,
    tableLookup: ReadonlyMap<string, DataSourceTable>,
  ): string {
    const table = tableLookup.get(field.tableId);
    const tableAlias = table?.alias ?? field.tableId;

    return `${quoteIdentifier(tableAlias)}.${quoteIdentifier(field.name)}`;
  }

  private createColumnExpression(
    expression: string,
    field: DataSourceField,
    tableLookup: ReadonlyMap<string, DataSourceTable>,
  ): string {
    return isDefaultFieldExpression(expression, field)
      ? this.createFieldExpression(field, tableLookup)
      : expression.trim();
  }

  private createJoinLines(
    tables: readonly DataSourceTable[],
    joins: readonly QueryJoin[],
    report: ReportDefinition,
    tableLookup: ReadonlyMap<string, DataSourceTable>,
    fieldLookup: ReadonlyMap<string, DataSourceField>,
    visitedSubqueryIds: ReadonlySet<string>,
  ): readonly string[] {
    const selectedTableIds = new Set(tables.map((table) => table.id));
    const joinedTableIds = new Set<string>([tables[0]?.id ?? '']);
    const pendingTables = tables.slice(1);
    const joinLines: string[] = [];

    while (pendingTables.length > 0) {
      const nextIndex = pendingTables.findIndex((table) =>
        joins.some((join) =>
          connectsTableToJoinedTable(join, table.id, joinedTableIds, selectedTableIds, fieldLookup),
        ),
      );
      const tableIndex = nextIndex >= 0 ? nextIndex : 0;
      const [table] = pendingTables.splice(tableIndex, 1);

      if (!table) {
        break;
      }

      const connectedJoins = joins.filter((candidateJoin) =>
        connectsTableToJoinedTable(
          candidateJoin,
          table.id,
          joinedTableIds,
          selectedTableIds,
          fieldLookup,
        ),
      );

      joinedTableIds.add(table.id);
      joinLines.push(
        connectedJoins.length > 0
          ? this.createJoinLine(
              table,
              connectedJoins,
              report,
              tableLookup,
              fieldLookup,
              visitedSubqueryIds,
            )
          : `CROSS JOIN ${this.createTableExpression(
              table,
              report,
              tableLookup,
              fieldLookup,
              visitedSubqueryIds,
            )}`,
      );
    }

    return joinLines;
  }

  private createJoinLine(
    table: DataSourceTable,
    joins: readonly QueryJoin[],
    report: ReportDefinition,
    tableLookup: ReadonlyMap<string, DataSourceTable>,
    fieldLookup: ReadonlyMap<string, DataSourceField>,
    visitedSubqueryIds: ReadonlySet<string>,
  ): string {
    const conflictingJoinIds = findConflictingJoinPairIds(joins, fieldLookup);

    if (conflictingJoinIds.size > 0) {
      return [
        `/* Invalid join: conflicting join types between the same datasource pair (${Array.from(conflictingJoinIds).join(', ')}) */`,
        `CROSS JOIN ${this.createTableExpression(
          table,
          report,
          tableLookup,
          fieldLookup,
          visitedSubqueryIds,
        )}`,
      ].join('\n');
    }

    const joinType = joins.find((join) => join.type !== 'cross')?.type ?? 'cross';

    if (joinType === 'cross') {
      return `CROSS JOIN ${this.createTableExpression(
        table,
        report,
        tableLookup,
        fieldLookup,
        visitedSubqueryIds,
      )}`;
    }

    const conditions = joins
      .filter((join) => join.type !== 'cross')
      .flatMap((join) => join.conditions)
      .map((condition) => this.createJoinConditionExpression(condition, tableLookup, fieldLookup))
      .filter((condition): condition is string => condition !== null);

    if (conditions.length === 0) {
      return `CROSS JOIN ${this.createTableExpression(
        table,
        report,
        tableLookup,
        fieldLookup,
        visitedSubqueryIds,
      )}`;
    }

    return `${joinKeyword(joinType)} JOIN ${this.createTableExpression(
      table,
      report,
      tableLookup,
      fieldLookup,
      visitedSubqueryIds,
    )} ON ${conditions.join(' AND ')}`;
  }

  private createJoinConditionExpression(
    condition: QueryJoinCondition,
    tableLookup: ReadonlyMap<string, DataSourceTable>,
    fieldLookup: ReadonlyMap<string, DataSourceField>,
  ): string | null {
    const fromField = fieldLookup.get(condition.fromFieldId);
    const toField = fieldLookup.get(condition.toFieldId);

    return fromField && toField
      ? `${this.createFieldExpression(fromField, tableLookup)} ${joinOperatorLabels[condition.operator]} ${this.createFieldExpression(toField, tableLookup)}`
      : null;
  }
}

function quoteIdentifier(value: string): string {
  return `[${value.replaceAll(']', ']]')}]`;
}

function formatParameterName(value: string): string {
  const trimmedValue = value.trim().replace(/^@/, '');

  return `@${trimmedValue}`;
}

function joinKeyword(type: QueryJoinType): string {
  switch (type) {
    case 'inner':
      return 'INNER';
    case 'right':
      return 'RIGHT';
    case 'full':
      return 'FULL OUTER';
    case 'cross':
      return 'CROSS';
    case 'left':
      return 'LEFT';
  }
}

function connectsTableToJoinedTable(
  join: QueryJoin,
  tableId: string,
  joinedTableIds: ReadonlySet<string>,
  selectedTableIds: ReadonlySet<string>,
  fieldLookup: ReadonlyMap<string, DataSourceField>,
): boolean {
  return join.conditions.some((condition) => {
    const fromField = fieldLookup.get(condition.fromFieldId);
    const toField = fieldLookup.get(condition.toFieldId);

    if (!fromField || !toField) {
      return false;
    }

    const joinsSelectedTables =
      selectedTableIds.has(fromField.tableId) && selectedTableIds.has(toField.tableId);
    const startsAtCurrentTable =
      fromField.tableId === tableId && joinedTableIds.has(toField.tableId);
    const endsAtCurrentTable = toField.tableId === tableId && joinedTableIds.has(fromField.tableId);

    return joinsSelectedTables && (startsAtCurrentTable || endsAtCurrentTable);
  });
}

function formatSqlValue(value: string, fieldType: FieldType): string {
  switch (fieldType) {
    case 'number':
      return Number.isFinite(Number(value)) ? value : 'NULL';
    case 'boolean':
      return value.toLowerCase() === 'true' || value === '1' ? '1' : '0';
    case 'date':
    case 'string':
      return quoteString(value);
  }
}

function quoteString(value: CellValue): string {
  return `'${String(value ?? '').replaceAll("'", "''")}'`;
}

function isDefaultFieldExpression(expression: string, field: DataSourceField): boolean {
  const normalizedExpression = expression
    .trim()
    .replaceAll('[', '')
    .replaceAll(']', '')
    .toLowerCase();
  const defaultExpressions = new Set([
    field.expression.toLowerCase(),
    field.id.toLowerCase(),
    `${field.tableId}.${field.name}`.toLowerCase(),
    field.name.toLowerCase(),
  ]);

  return defaultExpressions.has(normalizedExpression);
}

function createCriteriaExpression(
  expression: string,
  criteria: string,
  fieldType: FieldType,
): string | null {
  const trimmedCriteria = criteria.trim();

  if (!trimmedCriteria) {
    return null;
  }

  const operatorMatch = /^(>=|<=|<>|!=|=|>|<)\s*(.+)$/.exec(trimmedCriteria);

  if (operatorMatch) {
    const operator = operatorMatch[1] === '!=' ? '<>' : operatorMatch[1];
    const value = operatorMatch[2] ?? '';

    return `${expression} ${operator} ${formatSqlValue(value, fieldType)}`;
  }

  if (trimmedCriteria.includes('%')) {
    return `${expression} LIKE ${formatSqlValue(trimmedCriteria, 'string')}`;
  }

  return `${expression} = ${formatSqlValue(trimmedCriteria, fieldType)}`;
}
