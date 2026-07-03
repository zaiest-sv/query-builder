import { HttpClient } from '@angular/common/http';
import { inject, Injectable, InjectionToken } from '@angular/core';
import { map, Observable, of } from 'rxjs';
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
  PreviewRow,
  ReportDefinition,
  SortDirection,
} from '../models/report-definition.model';
import { getJoinTablePair } from './query-join-graph.service';
import { QueryPreviewService } from './query-preview.service';
import { QuerySqlBuilderService } from './query-sql-builder.service';
import { createSubqueryTableId } from './query-subquery-datasource.service';
import { QueryValidationService } from './query-validation.service';

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

export interface QueryValidationResponse {
  readonly status: 'valid' | 'invalid' | 'error';
  readonly issues: readonly string[];
  readonly checkedAt: string;
  readonly message: string;
}

export interface QueryPreviewRequest {
  readonly report: ReportDefinition;
  readonly queryId: 'main' | string;
  readonly limit: number;
  readonly parameterValues: Readonly<Record<string, string>>;
}

export interface QueryPreviewResponse {
  readonly status: 'ready' | 'invalid' | 'error';
  readonly columns: readonly QueryColumn[];
  readonly rows: readonly PreviewRow[];
  readonly issues: readonly string[];
  readonly generatedSql: string;
  readonly executionPlan?: string;
  readonly executedAt: string;
  readonly message: string;
}

export interface QueryEditorApi {
  loadReport(reportId: string): Observable<QueryEditorData>;
  saveReport(report: ReportDefinition): Observable<SaveReportResponse>;
  validateReport?(report: ReportDefinition): Observable<QueryValidationResponse>;
  previewReport?(request: QueryPreviewRequest): Observable<QueryPreviewResponse>;
}

@Injectable({ providedIn: 'root' })
export class MockQueryEditorApiService implements QueryEditorApi {
  private readonly previewService = inject(QueryPreviewService);
  private readonly sqlBuilder = inject(QuerySqlBuilderService);
  private readonly validationService = inject(QueryValidationService);
  private report = readStoredReport() ?? cloneReport(MOCK_REPORT);

  loadReport(reportId: string): Observable<QueryEditorData> {
    const report = reportId === this.report.id ? this.report : MOCK_REPORT;
    const metadata = cloneValue(DATA_SOURCE_GROUPS);

    return of({
      metadata,
      report: cloneReport(report, metadata),
      rows: cloneValue(MOCK_ROWS),
    });
  }

  saveReport(report: ReportDefinition): Observable<SaveReportResponse> {
    this.report = cloneReport(report, DATA_SOURCE_GROUPS);
    writeStoredReport(this.report);

    return of({
      report: cloneReport(this.report),
      savedAt: new Date().toISOString(),
      message: 'Mock report definition saved',
    });
  }

  validateReport(report: ReportDefinition): Observable<QueryValidationResponse> {
    const normalizedReport = cloneReport(report, DATA_SOURCE_GROUPS);
    const context = createDataContext(createSubqueryTables(normalizedReport.subqueries));
    const issues = this.validationService.validateReport(
      normalizedReport,
      context.tableLookup,
      context.fieldLookup,
    );

    return of({
      status: issues.length > 0 ? 'invalid' : 'valid',
      issues,
      checkedAt: new Date().toISOString(),
      message:
        issues.length > 0
          ? `${issues.length} validation issue${issues.length === 1 ? '' : 's'}`
          : 'Mock server validation passed',
    });
  }

  previewReport(request: QueryPreviewRequest): Observable<QueryPreviewResponse> {
    const report = cloneReport(request.report, DATA_SOURCE_GROUPS);
    const context = createDataContext(createSubqueryTables(report.subqueries));
    const query = findQueryDocument(report, request.queryId);
    const activeSubquery =
      request.queryId === 'main'
        ? null
        : (report.subqueries.find((subquery) => subquery.id === request.queryId) ?? null);
    const issues = this.validationService.validateActiveQuery(
      query,
      activeSubquery,
      report,
      context.tableLookup,
      context.fieldLookup,
    );
    const sourceRows = this.previewService.createDataRows(
      MOCK_ROWS,
      report,
      createDataContext().fieldLookup,
    );
    const parameterizedQuery = applyPreviewParameterValues(query, request.parameterValues);
    const filteredRows = this.previewService.applyPromptFilters(
      sourceRows,
      parameterizedQuery.filters,
      parameterizedQuery.parameters,
    );
    const rows = this.previewService
      .projectRows(
        this.previewService.sortRows(
          this.previewService.applyColumnCriteria(filteredRows, parameterizedQuery.columns),
          parameterizedQuery.columns,
        ),
        parameterizedQuery.columns.filter((column) => column.visible),
      )
      .slice(0, Math.max(1, request.limit));

    return of({
      status: issues.length > 0 ? 'invalid' : 'ready',
      columns: parameterizedQuery.columns.filter((column) => column.visible),
      rows,
      issues,
      generatedSql: this.sqlBuilder.buildQuery(
        parameterizedQuery,
        report,
        context.tableLookup,
        context.fieldLookup,
      ),
      executionPlan: `Mock execution plan: scan ${query.sourceTableIds.length} source${query.sourceTableIds.length === 1 ? '' : 's'}, project ${rows.length} row${rows.length === 1 ? '' : 's'}.`,
      executedAt: new Date().toISOString(),
      message:
        issues.length > 0
          ? 'Preview validation failed'
          : `Mock preview returned ${rows.length} row${rows.length === 1 ? '' : 's'}`,
    });
  }
}

export const QUERY_EDITOR_API_BASE_URL = new InjectionToken<string>('QueryEditorApiBaseUrl', {
  providedIn: 'root',
  factory: () => '/api/query-editor',
});

@Injectable({ providedIn: 'root' })
export class RealQueryEditorApiService implements QueryEditorApi {
  private readonly baseUrl = inject(QUERY_EDITOR_API_BASE_URL);
  private readonly http = inject(HttpClient);

  loadReport(reportId: string): Observable<QueryEditorData> {
    return this.http
      .get<unknown>(`${this.baseUrl}/reports/${encodeURIComponent(reportId)}`)
      .pipe(map((response) => normalizeQueryEditorData(response)));
  }

  saveReport(report: ReportDefinition): Observable<SaveReportResponse> {
    return this.http
      .put<unknown>(`${this.baseUrl}/reports/${encodeURIComponent(report.id)}`, report)
      .pipe(map((response) => normalizeSaveReportResponse(response, report)));
  }

  validateReport(report: ReportDefinition): Observable<QueryValidationResponse> {
    return this.http
      .post<unknown>(`${this.baseUrl}/reports/${encodeURIComponent(report.id)}/validate`, {
        report,
      })
      .pipe(map((response) => normalizeValidationResponse(response)));
  }

  previewReport(request: QueryPreviewRequest): Observable<QueryPreviewResponse> {
    return this.http
      .post<unknown>(
        `${this.baseUrl}/reports/${encodeURIComponent(request.report.id)}/preview`,
        request,
      )
      .pipe(map((response) => normalizePreviewResponse(response, request)));
  }
}

export const QUERY_EDITOR_API = new InjectionToken<QueryEditorApi>('QueryEditorApi', {
  providedIn: 'root',
  factory: () => inject(MockQueryEditorApiService),
});

function cloneReport(
  report: ReportDefinition,
  metadata: readonly DataSourceGroup[] = DATA_SOURCE_GROUPS,
): ReportDefinition {
  return normalizeReport(cloneValue(report), metadata);
}

function cloneValue<T>(value: T): T {
  return structuredClone(value);
}

function normalizeQueryEditorData(value: unknown): QueryEditorData {
  const rawData = isRecord(value) ? value : {};
  const metadata = normalizeMetadata(rawData['metadata'] ?? rawData['schema']);

  return {
    metadata,
    report: normalizeReport(rawData['report'], metadata),
    rows: normalizeRows(rawData['rows']),
  };
}

function normalizeSaveReportResponse(
  value: unknown,
  fallbackReport: ReportDefinition,
): SaveReportResponse {
  const rawResponse = isRecord(value) ? value : {};
  const metadata = normalizeMetadata(rawResponse['metadata'] ?? rawResponse['schema']);

  return {
    report: normalizeReport(rawResponse['report'] ?? fallbackReport, metadata),
    savedAt: readString(rawResponse['savedAt']) || new Date().toISOString(),
    message: readString(rawResponse['message']) || 'Report definition saved',
  };
}

function normalizeValidationResponse(value: unknown): QueryValidationResponse {
  const rawResponse = isRecord(value) ? value : {};
  const issues = readStringArray(rawResponse['issues']);
  const status = readValidationStatus(rawResponse['status'], issues);

  return {
    status,
    issues,
    checkedAt: readString(rawResponse['checkedAt']) || new Date().toISOString(),
    message:
      readString(rawResponse['message']) ||
      (status === 'valid'
        ? 'Server validation passed'
        : `${issues.length} validation issue${issues.length === 1 ? '' : 's'}`),
  };
}

function normalizePreviewResponse(
  value: unknown,
  request: QueryPreviewRequest,
): QueryPreviewResponse {
  const rawResponse = isRecord(value) ? value : {};
  const issues = readStringArray(rawResponse['issues']);
  const columns = normalizePreviewColumns(
    rawResponse['columns'],
    findQueryDocument(request.report, request.queryId).columns,
  );
  const rows = normalizePreviewRows(rawResponse['rows']);
  const status = readPreviewStatus(rawResponse['status'], issues);

  return {
    status,
    columns,
    rows,
    issues,
    generatedSql: readString(rawResponse['generatedSql']),
    ...(readString(rawResponse['executionPlan'])
      ? { executionPlan: readString(rawResponse['executionPlan']) }
      : {}),
    executedAt: readString(rawResponse['executedAt']) || new Date().toISOString(),
    message:
      readString(rawResponse['message']) ||
      (status === 'ready'
        ? `Preview returned ${rows.length} row${rows.length === 1 ? '' : 's'}`
        : 'Preview did not complete'),
  };
}

function normalizeMetadata(value: unknown): readonly DataSourceGroup[] {
  const groups = readArray(value)
    .map(normalizeDataSourceGroup)
    .filter((group): group is DataSourceGroup => group !== null);

  return groups.length > 0 ? groups : cloneValue(DATA_SOURCE_GROUPS);
}

function normalizeDataSourceGroup(value: unknown, index: number): DataSourceGroup | null {
  if (!isRecord(value)) {
    return null;
  }

  const tables = readArray(value['tables'])
    .map(normalizeDataSourceTable)
    .filter((table): table is DataSourceTable => table !== null);

  if (tables.length === 0) {
    return null;
  }

  const label = readString(value['label']) || `Group ${index + 1}`;

  return {
    id: readString(value['id']) || createSafeSqlAlias(label) || `group-${index + 1}`,
    label,
    tables,
  };
}

function normalizeDataSourceTable(value: unknown, index: number): DataSourceTable | null {
  if (!isRecord(value)) {
    return null;
  }

  const name = readString(value['name']);
  const label = readString(value['label']) || name || `Table ${index + 1}`;
  const id = readString(value['id']) || createSafeSqlAlias(name || label);

  if (!id) {
    return null;
  }

  const fields = readArray(value['fields'])
    .map((fieldValue, fieldIndex) => normalizeDataSourceField(fieldValue, fieldIndex, id))
    .filter((field): field is DataSourceField => field !== null);

  if (fields.length === 0) {
    return null;
  }

  const sourceType = value['sourceType'] === 'subquery' ? 'subquery' : undefined;
  const subqueryId = sourceType === 'subquery' ? readString(value['subqueryId']) : '';

  return {
    id,
    schema: readString(value['schema']) || 'dbo',
    name: name || id,
    alias: createSafeSqlAlias(readString(value['alias']) || name || label) || id,
    label,
    ...(sourceType ? { sourceType } : {}),
    ...(subqueryId ? { subqueryId } : {}),
    fields,
  };
}

function normalizeDataSourceField(
  value: unknown,
  index: number,
  tableId: string,
): DataSourceField | null {
  if (!isRecord(value)) {
    return null;
  }

  const name = readString(value['name']);
  const label = readString(value['label']) || name || `Field ${index + 1}`;
  const id = readString(value['id']) || `${tableId}.${createSafeSqlAlias(name || label)}`;

  if (!id || !name) {
    return null;
  }

  return {
    id,
    tableId: readString(value['tableId']) || tableId,
    name,
    label,
    expression: readString(value['expression']) || `${tableId}.${name}`,
    type: readFieldType(value['type']),
    nullable: readBoolean(value['nullable'], true),
    aggregations: normalizeAggregations(value['aggregations']),
  };
}

function normalizeAggregations(value: unknown): readonly CrosstabAggregation[] {
  const aggregations = readStringArray(value).filter(
    (aggregation): aggregation is CrosstabAggregation =>
      aggregation === 'count' ||
      aggregation === 'sum' ||
      aggregation === 'avg' ||
      aggregation === 'min' ||
      aggregation === 'max',
  );

  return aggregations.length > 0 ? aggregations : (['count'] as const);
}

function normalizeRows(value: unknown): readonly DataRecord[] {
  return readArray(value)
    .map((row, index) => normalizeDataRecord(row, index))
    .filter((row): row is DataRecord => row !== null);
}

function normalizeDataRecord(value: unknown, index: number): DataRecord | null {
  if (!isRecord(value)) {
    return null;
  }

  const record: { id: string } & Record<string, string | number | boolean | null> = {
    id: readString(value['id']) || `row-${index + 1}`,
  };

  for (const [key, cellValue] of Object.entries(value)) {
    if (key !== 'id') {
      record[key] = normalizeCellValue(cellValue);
    }
  }

  return record;
}

function normalizeReport(
  value: unknown,
  metadata: readonly DataSourceGroup[] = DATA_SOURCE_GROUPS,
): ReportDefinition {
  const rawReport = isRecord(value) ? value : (MOCK_REPORT as unknown as ReadonlyRecord);
  const rawSubqueries = readArray(rawReport['subqueries']);
  const rawSubqueryTables = createSubqueryTablesFromRaw(rawSubqueries, metadata);
  const rawContext = createDataContext(rawSubqueryTables, metadata);
  const subqueries = rawSubqueries
    .map((subquery, index) => normalizeSubquery(subquery, index, rawContext))
    .filter((subquery): subquery is QuerySubquery => subquery !== null);
  const context = createDataContext(createSubqueryTables(subqueries, metadata), metadata);
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

function createDataContext(
  extraTables: readonly DataSourceTable[] = [],
  metadata: readonly DataSourceGroup[] = DATA_SOURCE_GROUPS,
): DataContext {
  const tables = [...metadata.flatMap((group) => group.tables), ...extraTables];
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
    ...(readString(value['description']) ? { description: readString(value['description']) } : {}),
    settings: normalizeSubquerySettings(value['settings']),
    query: normalizeQuery(value['query'], context, createSubqueryTableId(id)),
  };
}

function normalizeSubquerySettings(value: unknown): QuerySubquery['settings'] {
  const rawSettings = isRecord(value) ? value : {};

  return {
    previewLimit: readBoundedInteger(rawSettings['previewLimit'], 100, 1, 500),
  };
}

function createSubqueryTablesFromRaw(
  values: readonly unknown[],
  metadata: readonly DataSourceGroup[],
): readonly DataSourceTable[] {
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

      return createSubqueryTable(id, name, alias, columns, metadata);
    })
    .filter((table): table is DataSourceTable => table !== null);
}

function createSubqueryTables(
  subqueries: readonly QuerySubquery[],
  metadata: readonly DataSourceGroup[] = DATA_SOURCE_GROUPS,
): readonly DataSourceTable[] {
  return subqueries.map((subquery) =>
    createSubqueryTable(
      subquery.id,
      subquery.name,
      subquery.alias,
      subquery.query.columns,
      metadata,
    ),
  );
}

function createSubqueryTable(
  id: string,
  name: string,
  alias: string,
  rawColumns: readonly unknown[],
  metadata: readonly DataSourceGroup[],
): DataSourceTable {
  const baseFieldLookup = createDataContext([], metadata).fieldLookup;
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

    if (conditions.length === 0) {
      continue;
    }

    const normalizedJoin = { ...join, conditions };
    const pair = getJoinTablePair(normalizedJoin, fieldLookup);
    const existingJoinIndex = pair
      ? normalizedJoins.findIndex((currentJoin) => {
          const currentPair = getJoinTablePair(currentJoin, fieldLookup);

          return currentPair?.key === pair.key && currentJoin.type === normalizedJoin.type;
        })
      : -1;

    const existingJoin = normalizedJoins[existingJoinIndex];

    if (existingJoin) {
      normalizedJoins[existingJoinIndex] = {
        ...existingJoin,
        conditions: [...existingJoin.conditions, ...conditions],
      };
    } else {
      normalizedJoins.push(normalizedJoin);
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

function findQueryDocument(report: ReportDefinition, queryId: string): QueryDocument {
  if (queryId === 'main') {
    return report.query;
  }

  return report.subqueries.find((subquery) => subquery.id === queryId)?.query ?? report.query;
}

function applyPreviewParameterValues(
  query: QueryDocument,
  parameterValues: Readonly<Record<string, string>>,
): QueryDocument {
  if (Object.keys(parameterValues).length === 0) {
    return query;
  }

  return {
    ...query,
    parameters: query.parameters.map((parameter) => ({
      ...parameter,
      defaultValue: parameterValues[parameter.name] ?? parameter.defaultValue,
    })),
  };
}

function normalizePreviewColumns(
  value: unknown,
  fallbackColumns: readonly QueryColumn[],
): readonly QueryColumn[] {
  const columns = readArray(value)
    .map(normalizePreviewColumn)
    .filter((column): column is QueryColumn => column !== null);

  return columns.length > 0 ? columns : fallbackColumns.filter((column) => column.visible);
}

function normalizePreviewColumn(value: unknown, index: number): QueryColumn | null {
  if (!isRecord(value)) {
    return null;
  }

  const id = readString(value['id']) || `preview-column-${index + 1}`;
  const alias = createSafeSqlAlias(readString(value['alias']) || id) || id;

  return {
    id,
    fieldId: readString(value['fieldId']) || id,
    expression: readString(value['expression']) || id,
    alias,
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

function normalizePreviewRows(value: unknown): readonly PreviewRow[] {
  return readArray(value)
    .map((row, index) => normalizePreviewRow(row, index))
    .filter((row): row is PreviewRow => row !== null);
}

function normalizePreviewRow(value: unknown, index: number): PreviewRow | null {
  if (!isRecord(value)) {
    return null;
  }

  const rawCells = isRecord(value['cells']) ? value['cells'] : value;
  const cells: Record<string, string | number | boolean | null> = {};

  for (const [key, cellValue] of Object.entries(rawCells)) {
    if (key !== 'id') {
      cells[key] = normalizeCellValue(cellValue);
    }
  }

  return {
    id: readString(value['id']) || `preview-row-${index + 1}`,
    cells,
  };
}

function normalizeCellValue(value: unknown): string | number | boolean | null {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return value;
  }

  return String(value);
}

function readValidationStatus(
  value: unknown,
  issues: readonly string[],
): QueryValidationResponse['status'] {
  if (value === 'valid' || value === 'invalid' || value === 'error') {
    return value;
  }

  return issues.length > 0 ? 'invalid' : 'valid';
}

function readPreviewStatus(
  value: unknown,
  issues: readonly string[],
): QueryPreviewResponse['status'] {
  if (value === 'ready' || value === 'invalid' || value === 'error') {
    return value;
  }

  return issues.length > 0 ? 'invalid' : 'ready';
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

function readBoundedInteger(value: unknown, fallback: number, min: number, max: number): number {
  const numberValue =
    typeof value === 'number'
      ? value
      : typeof value === 'string'
        ? Number.parseInt(value, 10)
        : Number.NaN;

  if (!Number.isFinite(numberValue)) {
    return fallback;
  }

  return Math.min(max, Math.max(min, Math.trunc(numberValue)));
}

function uniqueStrings(values: readonly string[]): readonly string[] {
  return [...new Set(values.map((value) => value.trim()).filter((value) => value.length > 0))];
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
  const kind = readParameterKind(value['kind']);
  const sourceFieldId = kind === 'dynamic' ? readString(value['sourceFieldId']) : '';

  return {
    id: readString(value['id']) || `parameter-${index + 1}`,
    name,
    label: readString(value['label']) || name,
    type: readFieldType(value['type']),
    required: typeof value['required'] === 'boolean' ? value['required'] : false,
    defaultValue: readString(value['defaultValue']),
    kind,
    ...(sourceFieldId ? { sourceFieldId } : {}),
    lookup: normalizeParameterLookup(value['lookup']),
  };
}

function normalizeParameterLookup(value: unknown): QueryParameter['lookup'] {
  const rawLookup = isRecord(value) ? value : {};

  return {
    enabled: readBoolean(rawLookup['enabled'], false),
    multiple: readBoolean(rawLookup['multiple'], false),
    options: readStringArray(rawLookup['options']),
  };
}

function readParameterKind(value: unknown): NonNullable<QueryParameter['kind']> {
  return value === 'dynamic' ? 'dynamic' : 'static';
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
