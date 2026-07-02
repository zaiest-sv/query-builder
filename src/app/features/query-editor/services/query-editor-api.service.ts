import { inject, Injectable, InjectionToken } from '@angular/core';
import { Observable, of } from 'rxjs';
import { DATA_SOURCE_GROUPS, MOCK_REPORT, MOCK_ROWS } from '../data/mock-report-data';
import {
  CrosstabAggregation,
  CrosstabDefinition,
  CrosstabValueDefinition,
  DataRecord,
  DataSourceField,
  DataSourceGroup,
  DataSourceTable,
  FieldType,
  FilterOperator,
  QueryCanvasTablePosition,
  QueryColumn,
  QueryDocument,
  QueryFilter,
  QueryJoin,
  QueryJoinCondition,
  QueryJoinOperator,
  QueryJoinType,
  QueryParameter,
  QuerySubquery,
  ReportDefinition,
  SortDirection,
} from '../models/report-definition.model';
import { createSubqueryTableId } from './query-subquery-datasource.service';

const mockReportStorageKey = 'query-builder.mock-report';
const mockReportStorageSchemaVersion = 2;

interface DataContext {
  readonly tableLookup: ReadonlyMap<string, DataSourceTable>;
  readonly fieldLookup: ReadonlyMap<string, DataSourceField>;
}

type ReadonlyRecord = Readonly<Record<string, unknown>>;

export interface QueryEditorData {
  readonly metadata: readonly DataSourceGroup[];
  readonly report: ReportDefinition;
  readonly rows: readonly DataRecord[];
}

export interface SaveReportResponse {
  readonly report: ReportDefinition;
  readonly savedAt: string;
  readonly message: string;
}

export interface QueryEditorApi {
  loadReport(reportId: string): Observable<QueryEditorData>;
  saveReport(report: ReportDefinition): Observable<SaveReportResponse>;
}

@Injectable({ providedIn: 'root' })
export class MockQueryEditorApiService implements QueryEditorApi {
  private report = readStoredReport() ?? cloneReport(MOCK_REPORT);

  loadReport(reportId: string): Observable<QueryEditorData> {
    const report = reportId === this.report.id ? this.report : MOCK_REPORT;

    return of({
      metadata: cloneValue(DATA_SOURCE_GROUPS),
      report: cloneReport(report),
      rows: cloneValue(MOCK_ROWS),
    });
  }

  saveReport(report: ReportDefinition): Observable<SaveReportResponse> {
    this.report = cloneReport(report);
    writeStoredReport(this.report);

    return of({
      report: cloneReport(this.report),
      savedAt: new Date().toISOString(),
      message: 'Mock report definition saved',
    });
  }
}

export const QUERY_EDITOR_API = new InjectionToken<QueryEditorApi>('QueryEditorApi', {
  providedIn: 'root',
  factory: () => inject(MockQueryEditorApiService),
});

function cloneReport(report: ReportDefinition): ReportDefinition {
  return normalizeReport(cloneValue(report));
}

function cloneValue<T>(value: T): T {
  return structuredClone(value);
}

function normalizeReport(value: unknown): ReportDefinition {
  const rawReport = isRecord(value) ? value : (MOCK_REPORT as unknown as ReadonlyRecord);
  const rawSubqueries = readArray(rawReport['subqueries']);
  const rawSubqueryTables = createSubqueryTablesFromRaw(rawSubqueries);
  const rawContext = createDataContext(rawSubqueryTables);
  const subqueries = rawSubqueries
    .map((subquery, index) => normalizeSubquery(subquery, index, rawContext))
    .filter((subquery): subquery is QuerySubquery => subquery !== null);
  const context = createDataContext(createSubqueryTables(subqueries));
  const query = normalizeQuery(rawReport['query'], context);

  return {
    id: readString(rawReport['id']) || MOCK_REPORT.id,
    tenantName: readString(rawReport['tenantName']) || MOCK_REPORT.tenantName,
    reportName: readString(rawReport['reportName']) || MOCK_REPORT.reportName,
    description: readString(rawReport['description']),
    query,
    subqueries,
    crosstab: normalizeCrosstab(rawReport['crosstab'], query, context.fieldLookup),
  };
}

function createDataContext(extraTables: readonly DataSourceTable[] = []): DataContext {
  const tables = [...DATA_SOURCE_GROUPS.flatMap((group) => group.tables), ...extraTables];
  const tableLookup = new Map(tables.map((table) => [table.id, table] as const));
  const fieldLookup = new Map(
    tables.flatMap((table) => table.fields).map((field) => [field.id, field] as const),
  );

  return { tableLookup, fieldLookup };
}

function normalizeQuery(value: unknown, context: DataContext, selfTableId = ''): QueryDocument {
  const rawQuery = isRecord(value) ? value : {};
  const rawSourceTableIds = readStringArray(rawQuery['sourceTableIds']).filter(
    (tableId) => tableId !== selfTableId && context.tableLookup.has(tableId),
  );
  const columns = readArray(rawQuery['columns'])
    .map((column, index) => normalizeColumn(column, index, context.fieldLookup))
    .filter((column): column is QueryColumn => column !== null);
  const parameters = normalizeParameters(rawQuery['parameters']);
  const filters = readArray(rawQuery['filters'])
    .map((filter, index) => normalizeFilter(filter, index, context.fieldLookup, parameters))
    .filter((filter): filter is QueryFilter => filter !== null);
  const joins = readArray(rawQuery['joins'])
    .map(normalizeJoin)
    .filter((join): join is QueryJoin => join !== null);
  const sourceTableIds = createSourceTableIds(
    rawSourceTableIds,
    columns,
    filters,
    joins,
    context.fieldLookup,
  ).filter((tableId) => tableId !== selfTableId && context.tableLookup.has(tableId));
  const sourceTableIdSet = new Set(sourceTableIds);
  const normalizedColumns = columns.filter((column) =>
    sourceTableIdSet.has(context.fieldLookup.get(column.fieldId)?.tableId ?? ''),
  );
  const normalizedFilters = filters.filter((filter) =>
    sourceTableIdSet.has(context.fieldLookup.get(filter.fieldId)?.tableId ?? ''),
  );

  return {
    sourceTableIds,
    columns: normalizedColumns,
    filters: normalizedFilters,
    joins: normalizeQueryJoins(joins, sourceTableIdSet, context.fieldLookup),
    layout: {
      tables: normalizeLayoutTables(rawQuery['layout'], sourceTableIdSet),
    },
    parameters,
  };
}

function normalizeSubquery(
  value: unknown,
  index: number,
  context: DataContext,
): QuerySubquery | null {
  if (!isRecord(value) || !isRecord(value['query'])) {
    return null;
  }

  const id = readString(value['id']) || `subquery-${index + 1}`;
  const name = readString(value['name']) || `Subquery ${index + 1}`;
  const alias = createSafeSqlAlias(readString(value['alias']) || name || id) || `sq${index + 1}`;

  return {
    id,
    name,
    alias,
    query: normalizeQuery(value['query'], context, createSubqueryTableId(id)),
  };
}

function createSubqueryTablesFromRaw(values: readonly unknown[]): readonly DataSourceTable[] {
  return values
    .map((value, index) => {
      if (!isRecord(value) || !isRecord(value['query'])) {
        return null;
      }

      const id = readString(value['id']) || `subquery-${index + 1}`;
      const name = readString(value['name']) || `Subquery ${index + 1}`;
      const alias =
        createSafeSqlAlias(readString(value['alias']) || name || id) || `sq${index + 1}`;
      const columns = readArray(value['query']['columns']);

      return createSubqueryTable(id, name, alias, columns);
    })
    .filter((table): table is DataSourceTable => table !== null);
}

function createSubqueryTables(subqueries: readonly QuerySubquery[]): readonly DataSourceTable[] {
  return subqueries.map((subquery) =>
    createSubqueryTable(subquery.id, subquery.name, subquery.alias, subquery.query.columns),
  );
}

function createSubqueryTable(
  id: string,
  name: string,
  alias: string,
  rawColumns: readonly unknown[],
): DataSourceTable {
  const baseFieldLookup = createDataContext().fieldLookup;
  const tableId = createSubqueryTableId(id);
  const fields = rawColumns
    .map((column, index) => {
      if (!isRecord(column) || column['visible'] === false) {
        return null;
      }

      const sourceField = baseFieldLookup.get(readString(column['fieldId']));
      const fieldName =
        createSafeSqlAlias(
          readString(column['alias']) || sourceField?.name || `Column${index + 1}`,
        ) || `Column${index + 1}`;

      return {
        id: `${tableId}.${fieldName}`,
        tableId,
        name: fieldName,
        label: readString(column['alias']) || sourceField?.label || fieldName,
        expression: `${alias}.${fieldName}`,
        type: sourceField?.type ?? 'string',
        nullable: sourceField?.nullable ?? true,
        aggregations: sourceField?.aggregations ?? (['count'] as const),
      };
    })
    .filter((field): field is DataSourceField => field !== null);

  return {
    id: tableId,
    schema: 'subquery',
    name,
    alias,
    label: name,
    sourceType: 'subquery',
    subqueryId: id,
    fields,
  };
}

function normalizeColumn(
  value: unknown,
  index: number,
  fieldLookup: ReadonlyMap<string, DataSourceField>,
): QueryColumn | null {
  if (!isRecord(value)) {
    return null;
  }

  const field = fieldLookup.get(readString(value['fieldId']));

  if (!field) {
    return null;
  }

  return {
    id: readString(value['id']) || `column-${index + 1}`,
    fieldId: field.id,
    expression: readString(value['expression']) || field.expression,
    alias: createSafeSqlAlias(readString(value['alias']) || field.label || field.name),
    visible: readBoolean(value['visible'], true),
    sortDirection: readSortDirection(value['sortDirection']),
    ...(readOptionalNumber(value['sortOrder']) !== null
      ? { sortOrder: readOptionalNumber(value['sortOrder']) ?? undefined }
      : {}),
    ...(typeof value['groupBy'] === 'boolean' ? { groupBy: value['groupBy'] } : {}),
    ...(readString(value['criteria']) ? { criteria: readString(value['criteria']) } : {}),
    ...(readStringArray(value['orCriteria']).length > 0
      ? { orCriteria: readStringArray(value['orCriteria']) }
      : {}),
  };
}

function normalizeParameters(value: unknown): readonly QueryParameter[] {
  const names = new Set<string>();
  const parameters: QueryParameter[] = [];

  for (const [index, parameterValue] of readArray(value).entries()) {
    const parameter = normalizeParameter(parameterValue, index);

    if (!parameter || names.has(parameter.name.toLowerCase())) {
      continue;
    }

    names.add(parameter.name.toLowerCase());
    parameters.push(parameter);
  }

  return parameters;
}

function normalizeFilter(
  value: unknown,
  index: number,
  fieldLookup: ReadonlyMap<string, DataSourceField>,
  parameters: readonly QueryParameter[],
): QueryFilter | null {
  if (!isRecord(value)) {
    return null;
  }

  const field = fieldLookup.get(readString(value['fieldId']));

  if (!field) {
    return null;
  }

  const parameterNames = new Set(parameters.map((parameter) => parameter.name));
  const parameterName = normalizeParameterReference(readString(value['parameterName']));

  return {
    id: readString(value['id']) || `filter-${index + 1}`,
    fieldId: field.id,
    operator: readFilterOperator(value['operator']),
    value: readString(value['value']),
    parameterName: parameterNames.has(parameterName) ? parameterName : '',
  };
}

function createSourceTableIds(
  sourceTableIds: readonly string[],
  columns: readonly QueryColumn[],
  filters: readonly QueryFilter[],
  joins: readonly QueryJoin[],
  fieldLookup: ReadonlyMap<string, DataSourceField>,
): readonly string[] {
  const tableIds = new Set(sourceTableIds);

  for (const column of columns) {
    addFieldTableId(tableIds, column.fieldId, fieldLookup);
  }

  for (const filter of filters) {
    addFieldTableId(tableIds, filter.fieldId, fieldLookup);
  }

  for (const join of joins) {
    for (const condition of join.conditions) {
      addFieldTableId(tableIds, condition.fromFieldId, fieldLookup);
      addFieldTableId(tableIds, condition.toFieldId, fieldLookup);
    }
  }

  return [...tableIds];
}

function addFieldTableId(
  tableIds: Set<string>,
  fieldId: string,
  fieldLookup: ReadonlyMap<string, DataSourceField>,
): void {
  const tableId = fieldLookup.get(fieldId)?.tableId;

  if (tableId) {
    tableIds.add(tableId);
  }
}

function normalizeQueryJoins(
  joins: readonly QueryJoin[],
  sourceTableIds: ReadonlySet<string>,
  fieldLookup: ReadonlyMap<string, DataSourceField>,
): readonly QueryJoin[] {
  const normalizedJoins: QueryJoin[] = [];

  for (const join of joins) {
    const conditions = join.conditions.filter((condition) => {
      const fromField = fieldLookup.get(condition.fromFieldId);
      const toField = fieldLookup.get(condition.toFieldId);

      return (
        fromField !== undefined &&
        toField !== undefined &&
        fromField.tableId !== toField.tableId &&
        sourceTableIds.has(fromField.tableId) &&
        sourceTableIds.has(toField.tableId)
      );
    });

    if (conditions.length > 0) {
      normalizedJoins.push({ ...join, conditions });
    }
  }

  return normalizedJoins;
}

function normalizeLayoutTables(
  value: unknown,
  sourceTableIds: ReadonlySet<string>,
): readonly QueryCanvasTablePosition[] {
  const rawTables = isRecord(value) ? readArray(value['tables']) : [];
  const usedTableIds = new Set<string>();
  const positions: QueryCanvasTablePosition[] = [];

  for (const position of rawTables) {
    if (!isRecord(position)) {
      continue;
    }

    const tableId = readString(position['tableId']);

    if (!sourceTableIds.has(tableId) || usedTableIds.has(tableId)) {
      continue;
    }

    usedTableIds.add(tableId);
    positions.push({
      tableId,
      x: readOptionalNumber(position['x']) ?? 0,
      y: readOptionalNumber(position['y']) ?? 0,
    });
  }

  return positions;
}

function normalizeJoin(value: unknown, index: number): QueryJoin | null {
  if (!isRecord(value)) {
    return null;
  }

  const joinId = readString(value['id']) || `join-${index + 1}`;
  const type = readJoinType(value['type']);
  const rawConditions = Array.isArray(value['conditions'])
    ? value['conditions']
    : [
        {
          id: `${joinId}-condition-1`,
          fromFieldId: value['fromFieldId'],
          operator: 'equals',
          toFieldId: value['toFieldId'],
        },
      ];
  const conditions = rawConditions
    .map((condition, conditionIndex) => normalizeJoinCondition(joinId, condition, conditionIndex))
    .filter((condition): condition is QueryJoinCondition => condition !== null);

  return conditions.length > 0
    ? {
        id: joinId,
        type,
        conditions,
      }
    : null;
}

function normalizeJoinCondition(
  joinId: string,
  value: unknown,
  index: number,
): QueryJoinCondition | null {
  if (!isRecord(value)) {
    return null;
  }

  const fromFieldId = readString(value['fromFieldId']);
  const toFieldId = readString(value['toFieldId']);

  if (!fromFieldId || !toFieldId) {
    return null;
  }

  return {
    id: readString(value['id']) || `${joinId}-condition-${index + 1}`,
    fromFieldId,
    operator: readJoinOperator(value['operator']),
    toFieldId,
  };
}

function normalizeCrosstab(
  value: unknown,
  query: QueryDocument,
  fieldLookup: ReadonlyMap<string, DataSourceField>,
): CrosstabDefinition {
  const rawCrosstab = isRecord(value) ? value : (MOCK_REPORT.crosstab as unknown as ReadonlyRecord);
  const crosstabFieldLookup = createCrosstabFieldLookup(query.columns, fieldLookup);

  return {
    rowFieldIds: normalizeCrosstabFieldIds(
      rawCrosstab['rowFieldIds'],
      query.columns,
      crosstabFieldLookup,
    ),
    columnFieldIds: normalizeCrosstabFieldIds(
      rawCrosstab['columnFieldIds'],
      query.columns,
      crosstabFieldLookup,
    ),
    values: normalizeCrosstabValues(rawCrosstab['values'], query.columns, crosstabFieldLookup),
    includeRowTotals: readBoolean(rawCrosstab['includeRowTotals'], true),
    includeColumnTotals: readBoolean(rawCrosstab['includeColumnTotals'], true),
  };
}

function createCrosstabFieldLookup(
  columns: readonly QueryColumn[],
  fieldLookup: ReadonlyMap<string, DataSourceField>,
): ReadonlyMap<string, DataSourceField> {
  return new Map(
    columns.map((column) => {
      const sourceField = fieldLookup.get(column.fieldId);

      return [
        column.id,
        {
          id: column.id,
          tableId: 'query-output',
          name: createSafeSqlAlias(column.alias || sourceField?.name || column.id),
          label: column.alias || sourceField?.label || column.id,
          expression: column.expression,
          type: sourceField?.type ?? 'string',
          nullable: sourceField?.nullable ?? true,
          aggregations: sourceField?.aggregations ?? (['count'] as const),
        },
      ] as const;
    }),
  );
}

function normalizeCrosstabFieldIds(
  value: unknown,
  columns: readonly QueryColumn[],
  crosstabFieldLookup: ReadonlyMap<string, DataSourceField>,
): readonly string[] {
  return uniqueStrings(
    readStringArray(value)
      .map((fieldId) => normalizeCrosstabFieldId(fieldId, columns))
      .filter((fieldId) => crosstabFieldLookup.has(fieldId)),
  );
}

function normalizeCrosstabValues(
  value: unknown,
  columns: readonly QueryColumn[],
  crosstabFieldLookup: ReadonlyMap<string, DataSourceField>,
): readonly CrosstabValueDefinition[] {
  const usedValueKeys = new Set<string>();
  const values: CrosstabValueDefinition[] = [];

  for (const [index, rawValue] of readArray(value).entries()) {
    if (!isRecord(rawValue)) {
      continue;
    }

    const fieldId = normalizeCrosstabFieldId(readString(rawValue['fieldId']), columns);
    const field = crosstabFieldLookup.get(fieldId);
    const aggregation = readCrosstabAggregation(rawValue['aggregation']);
    const valueKey = `${fieldId}:${aggregation}`;

    if (!field || !field.aggregations.includes(aggregation) || usedValueKeys.has(valueKey)) {
      continue;
    }

    usedValueKeys.add(valueKey);
    values.push({
      id: readString(rawValue['id']) || `value-${index + 1}`,
      fieldId,
      label: readString(rawValue['label']) || field.label,
      aggregation,
    });
  }

  return values;
}

function normalizeCrosstabFieldId(fieldId: string, columns: readonly QueryColumn[]): string {
  return columns.find((column) => column.fieldId === fieldId)?.id ?? fieldId;
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function readArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function readStringArray(value: unknown): readonly string[] {
  return uniqueStrings(readArray(value).filter((item): item is string => typeof item === 'string'));
}

function readBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function readOptionalNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function uniqueStrings(values: readonly string[]): readonly string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))];
}

function readJoinType(value: unknown): QueryJoinType {
  return value === 'inner' || value === 'right' || value === 'full' || value === 'cross'
    ? value
    : 'left';
}

function readSortDirection(value: unknown): SortDirection {
  return value === 'asc' || value === 'desc' ? value : 'none';
}

function readFilterOperator(value: unknown): FilterOperator {
  return value === 'notEquals' ||
    value === 'contains' ||
    value === 'greaterThan' ||
    value === 'lessThan' ||
    value === 'isEmpty'
    ? value
    : 'equals';
}

function readCrosstabAggregation(value: unknown): CrosstabAggregation {
  return value === 'sum' || value === 'avg' || value === 'min' || value === 'max' ? value : 'count';
}

function readJoinOperator(value: unknown): QueryJoinOperator {
  return value === 'notEquals' ||
    value === 'greaterThan' ||
    value === 'greaterThanOrEquals' ||
    value === 'lessThan' ||
    value === 'lessThanOrEquals'
    ? value
    : 'equals';
}

function normalizeParameter(value: unknown, index: number): QueryParameter | null {
  if (!isRecord(value)) {
    return null;
  }

  const name = createSafeParameterName(readString(value['name']) || `Parameter${index + 1}`);

  return {
    id: readString(value['id']) || `parameter-${index + 1}`,
    name,
    label: readString(value['label']) || name,
    type: readFieldType(value['type']),
    required: typeof value['required'] === 'boolean' ? value['required'] : false,
    defaultValue: readString(value['defaultValue']),
  };
}

function readFieldType(value: unknown): FieldType {
  return value === 'number' || value === 'date' || value === 'boolean' ? value : 'string';
}

function normalizeParameterReference(name: string): string {
  return name.trim().replace(/^@+/, '');
}

function createSafeParameterName(name: string): string {
  const normalizedName = normalizeParameterReference(name).replace(/[^A-Za-z0-9_]/g, '_');
  const safeName = /^[A-Za-z]/.test(normalizedName)
    ? normalizedName
    : `Parameter_${normalizedName}`;

  return safeName.replace(/_+/g, '_').replace(/_$/g, '') || 'Parameter';
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

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null;
}

function readStoredReport(): ReportDefinition | null {
  try {
    const storedReport = globalThis.localStorage?.getItem(mockReportStorageKey);
    const parsedReport = storedReport ? JSON.parse(storedReport) : null;
    const rawReport = readStoredReportPayload(parsedReport);

    if (!rawReport) {
      removeStoredReport();
      return null;
    }

    const rawReportId = readString(rawReport['id']);

    if (rawReportId && rawReportId !== MOCK_REPORT.id) {
      removeStoredReport();
      return null;
    }

    const report = normalizeReport(rawReport);

    writeStoredReport(report);

    return report;
  } catch {
    removeStoredReport();
    return null;
  }
}

function writeStoredReport(report: ReportDefinition): void {
  try {
    globalThis.localStorage?.setItem(
      mockReportStorageKey,
      JSON.stringify({
        schemaVersion: mockReportStorageSchemaVersion,
        report,
      }),
    );
  } catch {
    // Mock persistence is best-effort only.
  }
}

function readStoredReportPayload(value: unknown): ReadonlyRecord | null {
  if (!isRecord(value)) {
    return null;
  }

  if (isRecord(value['report'])) {
    return value['report'];
  }

  return isRecord(value['query']) ? value : null;
}

function removeStoredReport(): void {
  try {
    globalThis.localStorage?.removeItem(mockReportStorageKey);
  } catch {
    // Mock persistence is best-effort only.
  }
}
