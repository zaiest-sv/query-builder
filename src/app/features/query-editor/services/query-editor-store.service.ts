import { computed, DestroyRef, inject, Injectable, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import {
  CrosstabAggregation,
  DataRecord,
  DataSourceField,
  DataSourceGroup,
  DataSourceTable,
  FieldType,
  FilterOperator,
  PreviewRow,
  QueryColumn,
  QueryCanvasTablePosition,
  QueryDocument,
  QueryFilter,
  QueryJoin,
  QueryJoinCondition,
  QueryJoinOperator,
  QueryJoinType,
  QueryParameter,
  QuerySubquery,
  ReportDefinition,
  SaveState,
  SortDirection,
} from '../models/report-definition.model';
import { CrosstabEngineService } from './crosstab-engine.service';
import { createSafeSqlAlias, QueryCrosstabConfigService } from './query-crosstab-config.service';
import {
  QUERY_EDITOR_API,
  QueryPreviewRequest,
  QueryPreviewResponse,
  QueryValidationResponse,
} from './query-editor-api.service';
import {
  areJoinConditionsEqual,
  findConflictingJoinPairIds,
  findDuplicateJoinConditionIds,
  findDuplicateJoinPairIds,
  JoinDropAssessment,
  joinTouchesTable,
  QueryJoinGraphService,
} from './query-join-graph.service';
import { QueryPreviewService } from './query-preview.service';
import { QuerySqlBuilderService } from './query-sql-builder.service';
import { QuerySubqueryDatasourceService } from './query-subquery-datasource.service';
import { QueryValidationService } from './query-validation.service';

export type { JoinDropAssessment, JoinDropMode } from './query-join-graph.service';

interface EditorLoadState {
  readonly status: 'loading' | 'ready' | 'error';
  readonly message: string;
}

interface ServerValidationState {
  readonly status: 'idle' | 'checking' | QueryValidationResponse['status'];
  readonly message: string;
  readonly issues: readonly string[];
  readonly checkedAt?: string;
}

interface ServerPreviewState {
  readonly status: 'idle' | 'loading' | QueryPreviewResponse['status'];
  readonly message: string;
  readonly columns: readonly QueryColumn[];
  readonly rows: readonly PreviewRow[];
  readonly issues: readonly string[];
  readonly generatedSql: string;
  readonly executionPlan?: string;
  readonly executedAt?: string;
}

export type CanvasJoinStatus = 'valid' | 'warning' | 'error';

export interface CanvasJoinIssue {
  readonly level: Exclude<CanvasJoinStatus, 'valid'>;
  readonly message: string;
  readonly conditionId?: string;
}

export interface CanvasJoin {
  readonly id: string;
  readonly fromFieldId: string;
  readonly toFieldId: string;
  readonly fromTableId: string;
  readonly toTableId: string;
  readonly fromLabel: string;
  readonly toLabel: string;
  readonly type: QueryJoinType;
  readonly conditionCount: number;
  readonly conditions: readonly CanvasJoinCondition[];
  readonly status: CanvasJoinStatus;
  readonly issues: readonly CanvasJoinIssue[];
  readonly expression: string;
}

export interface CanvasJoinCondition {
  readonly id: string;
  readonly fromFieldId: string;
  readonly toFieldId: string;
  readonly fromTableId: string;
  readonly toTableId: string;
  readonly fromLabel: string;
  readonly toLabel: string;
  readonly operator: QueryJoinOperator;
  readonly status: CanvasJoinStatus;
  readonly issues: readonly CanvasJoinIssue[];
  readonly expression: string;
}

export type QueryCanvasSelection =
  | { readonly kind: 'none' }
  | { readonly kind: 'table'; readonly tableId: string }
  | { readonly kind: 'field'; readonly fieldId: string }
  | { readonly kind: 'join'; readonly joinId: string };

export type QueryWorkspaceId = 'main' | string;

@Injectable({ providedIn: 'root' })
export class QueryEditorStore {
  private readonly api = inject(QUERY_EDITOR_API);
  private readonly crosstabConfig = inject(QueryCrosstabConfigService);
  private readonly crosstabEngine = inject(CrosstabEngineService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly joinGraph = inject(QueryJoinGraphService);
  private readonly previewService = inject(QueryPreviewService);
  private readonly sqlBuilder = inject(QuerySqlBuilderService);
  private readonly subqueryDatasource = inject(QuerySubqueryDatasourceService);
  private readonly validationService = inject(QueryValidationService);
  private readonly metadataSignal = signal<readonly DataSourceGroup[]>([]);
  private readonly sourceRowsSignal = signal<readonly DataRecord[]>([]);
  private readonly reportSignal = signal<ReportDefinition>(createEmptyReport());
  private readonly activeQueryIdSignal = signal<QueryWorkspaceId>('main');
  private readonly canvasSelectionSignal = signal<QueryCanvasSelection>({ kind: 'none' });
  private readonly searchTermSignal = signal('');
  private readonly selectedTableIdSignal = signal('');
  private readonly dirtySignal = signal(false);
  private readonly loadStateSignal = signal<EditorLoadState>({
    status: 'loading',
    message: 'Loading report',
  });
  private readonly saveStateSignal = signal<SaveState>({
    status: 'idle',
    message: 'No changes saved yet',
  });
  private readonly serverValidationSignal = signal<ServerValidationState>({
    status: 'idle',
    message: 'Server validation has not run',
    issues: [],
  });
  private readonly serverPreviewSignal = signal<ServerPreviewState>({
    status: 'idle',
    message: 'Server preview has not run',
    columns: [],
    rows: [],
    issues: [],
    generatedSql: '',
  });
  private sequence = 1;

  readonly metadata = this.metadataSignal.asReadonly();
  readonly activeQueryId = this.activeQueryIdSignal.asReadonly();
  readonly canvasSelection = this.canvasSelectionSignal.asReadonly();
  readonly report = this.reportSignal.asReadonly();
  readonly searchTerm = this.searchTermSignal.asReadonly();
  readonly selectedTableId = this.selectedTableIdSignal.asReadonly();
  readonly isDirty = this.dirtySignal.asReadonly();
  readonly loadState = this.loadStateSignal.asReadonly();
  readonly saveState = this.saveStateSignal.asReadonly();
  readonly serverValidation = this.serverValidationSignal.asReadonly();
  readonly serverPreview = this.serverPreviewSignal.asReadonly();

  readonly baseTables = computed(() => this.metadata().flatMap((group) => group.tables));
  readonly baseFieldLookup = computed(
    () =>
      new Map(
        this.baseTables()
          .flatMap((table) => table.fields)
          .map((field) => [field.id, field] as const),
      ),
  );
  readonly subqueryTables = computed(() =>
    this.report().subqueries.map((subquery) =>
      this.subqueryDatasource.createTable(subquery, this.baseFieldLookup()),
    ),
  );
  readonly metadataWithSubqueries = computed(() => {
    const subqueryTables = this.subqueryTables();

    return subqueryTables.length === 0
      ? this.metadata()
      : [
          ...this.metadata(),
          {
            id: 'subqueries',
            label: 'Subqueries',
            tables: subqueryTables,
          },
        ];
  });
  readonly allTables = computed(() =>
    this.metadataWithSubqueries().flatMap((group) => group.tables),
  );
  readonly allFields = computed(() => this.allTables().flatMap((table) => table.fields));
  readonly tableLookup = computed(
    () => new Map(this.allTables().map((table) => [table.id, table] as const)),
  );
  readonly fieldLookup = computed(
    () => new Map(this.allFields().map((field) => [field.id, field] as const)),
  );
  readonly activeSubquery = computed(() =>
    this.activeQueryId() === 'main'
      ? null
      : (this.report().subqueries.find((subquery) => subquery.id === this.activeQueryId()) ?? null),
  );
  readonly activeQuery = computed(() => this.activeSubquery()?.query ?? this.report().query);
  readonly activeQueryLabel = computed(() => this.activeSubquery()?.name ?? 'Main Query');
  readonly selectedTables = computed(() =>
    this.activeQuery()
      .sourceTableIds.map((tableId) => this.tableLookup().get(tableId))
      .filter((table): table is DataSourceTable => table !== undefined),
  );
  readonly activeTable = computed(() => this.tableLookup().get(this.selectedTableId()) ?? null);
  readonly selectedColumns = computed(() => this.activeQuery().columns);
  readonly selectedCanvasTable = computed(() => {
    const selection = this.canvasSelection();

    return selection.kind === 'table' ? (this.tableLookup().get(selection.tableId) ?? null) : null;
  });
  readonly selectedCanvasField = computed(() => {
    const selection = this.canvasSelection();

    return selection.kind === 'field' ? (this.fieldLookup().get(selection.fieldId) ?? null) : null;
  });
  readonly selectedFieldIds = computed(
    () => new Set(this.selectedColumns().map((column) => column.fieldId)),
  );
  readonly previewDataRows = computed(() =>
    this.previewService.createDataRows(
      this.sourceRowsSignal(),
      this.report(),
      this.baseFieldLookup(),
    ),
  );
  readonly previewColumns = computed(() =>
    this.report().query.columns.filter((column) => column.visible),
  );
  readonly activePreviewColumns = computed(() =>
    this.activeQuery().columns.filter((column) => column.visible),
  );
  readonly canvasTablePositions = computed(
    () =>
      new Map(
        this.activeQuery().layout.tables.map((position) => [position.tableId, position] as const),
      ),
  );
  readonly joinedFieldIds = computed(() => {
    const fieldIds = new Set<string>();

    for (const join of this.activeQuery().joins) {
      for (const condition of join.conditions) {
        fieldIds.add(condition.fromFieldId);
        fieldIds.add(condition.toFieldId);
      }
    }

    return fieldIds;
  });
  readonly fieldsForSelectedSources = computed(() =>
    this.selectedTables().flatMap((table) => table.fields),
  );
  readonly filteredMetadata = computed(() =>
    filterMetadata(this.metadataWithSubqueries(), this.searchTerm()),
  );
  readonly filteredSourceRows = computed(() =>
    this.previewService.applyPromptFilters(
      this.previewDataRows(),
      this.report().query.filters,
      this.report().query.parameters,
    ),
  );
  readonly activeFilteredSourceRows = computed(() =>
    this.previewService.applyPromptFilters(
      this.previewDataRows(),
      this.activeQuery().filters,
      this.activeQuery().parameters,
    ),
  );
  readonly previewSourceRows = computed(() =>
    this.previewService.sortRows(
      this.previewService.applyColumnCriteria(
        this.filteredSourceRows(),
        this.report().query.columns,
      ),
      this.report().query.columns,
    ),
  );
  readonly previewRows = computed(() =>
    this.previewService.projectRows(this.previewSourceRows(), this.previewColumns()),
  );
  readonly crosstabFields = computed(() =>
    this.crosstabConfig.createOutputFields(this.report().query.columns, this.fieldLookup()),
  );
  readonly crosstabFieldLookup = computed(
    () => new Map(this.crosstabFields().map((field) => [field.id, field] as const)),
  );
  readonly crosstabDefinition = computed(() =>
    this.crosstabConfig.normalizeDefinition(this.report().crosstab, this.report().query.columns),
  );
  readonly renderableCrosstabDefinition = computed(() =>
    this.crosstabConfig.createRenderableDefinition(
      this.crosstabDefinition(),
      this.crosstabFieldLookup(),
    ),
  );
  readonly crosstabConfigIssues = computed(() =>
    this.crosstabConfig.createConfigIssues(this.crosstabDefinition(), this.crosstabFieldLookup()),
  );
  readonly crosstabRows = computed(() =>
    this.previewService
      .projectRows(this.previewSourceRows(), this.report().query.columns)
      .map((row) => ({
        id: row.id,
        ...row.cells,
      })),
  );
  readonly activePreviewSourceRows = computed(() =>
    this.previewService.sortRows(
      this.previewService.applyColumnCriteria(
        this.activeFilteredSourceRows(),
        this.activeQuery().columns,
      ),
      this.activeQuery().columns,
    ),
  );
  readonly activePreviewRows = computed(() =>
    this.previewService.projectRows(this.activePreviewSourceRows(), this.activePreviewColumns()),
  );
  readonly sql = computed(() =>
    this.sqlBuilder.build(this.report(), this.tableLookup(), this.fieldLookup()),
  );
  readonly activeSql = computed(() =>
    this.sqlBuilder.buildQuery(
      this.activeQuery(),
      this.report(),
      this.tableLookup(),
      this.fieldLookup(),
    ),
  );
  readonly validationIssues = computed(() =>
    this.validationService.validateReport(this.report(), this.tableLookup(), this.fieldLookup()),
  );
  readonly activeValidationIssues = computed(() =>
    this.validationService.validateActiveQuery(
      this.activeQuery(),
      this.activeSubquery(),
      this.report(),
      this.tableLookup(),
      this.fieldLookup(),
    ),
  );
  readonly canvasJoins = computed(() => {
    const activeQuery = this.activeQuery();
    const fieldLookup = this.fieldLookup();
    const duplicatePairJoinIds = findDuplicateJoinPairIds(activeQuery.joins, fieldLookup);
    const conflictingPairJoinIds = findConflictingJoinPairIds(activeQuery.joins, fieldLookup);

    return activeQuery.joins
      .map((join) =>
        createCanvasJoin(
          join,
          this.tableLookup(),
          fieldLookup,
          duplicatePairJoinIds,
          conflictingPairJoinIds,
        ),
      )
      .filter((join): join is CanvasJoin => join !== null);
  });
  readonly selectedCanvasJoin = computed(() => {
    const selection = this.canvasSelection();

    return selection.kind === 'join'
      ? (this.canvasJoins().find((join) => join.id === selection.joinId) ?? null)
      : null;
  });
  readonly crosstabMatrix = computed(() =>
    this.crosstabEngine.createMatrix(
      this.crosstabRows(),
      this.renderableCrosstabDefinition(),
      this.crosstabFieldLookup(),
    ),
  );
  readonly reportJson = computed(() => JSON.stringify(this.report(), null, 2));

  constructor() {
    this.loadReport('report-daily-check');
  }

  loadReport(reportId: string): void {
    this.loadStateSignal.set({
      status: 'loading',
      message: 'Loading report',
    });

    this.api
      .loadReport(reportId)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (data) => {
          this.metadataSignal.set(data.metadata);
          this.sourceRowsSignal.set(data.rows);
          this.reportSignal.set(data.report);
          this.activeQueryIdSignal.set('main');
          const initialTableId =
            data.report.query.sourceTableIds[0] ?? data.metadata[0]?.tables[0]?.id ?? '';
          this.selectedTableIdSignal.set(initialTableId);
          this.canvasSelectionSignal.set(
            data.report.query.sourceTableIds[0]
              ? { kind: 'table', tableId: data.report.query.sourceTableIds[0] }
              : { kind: 'none' },
          );
          this.dirtySignal.set(false);
          this.loadStateSignal.set({
            status: 'ready',
            message: 'Report loaded',
          });
          this.saveStateSignal.set({
            status: 'idle',
            message: 'No changes saved yet',
          });
          this.serverValidationSignal.set({
            status: 'idle',
            message: 'Server validation has not run',
            issues: [],
          });
          this.serverPreviewSignal.set({
            status: 'idle',
            message: 'Server preview has not run',
            columns: [],
            rows: [],
            issues: [],
            generatedSql: '',
          });
        },
        error: () => {
          this.loadStateSignal.set({
            status: 'error',
            message: 'Unable to load report',
          });
        },
      });
  }

  selectMainQuery(): void {
    this.activeQueryIdSignal.set('main');
    this.clearCanvasSelection();
  }

  selectSubquery(subqueryId: string): void {
    const subquery = this.report().subqueries.find(
      (currentSubquery) => currentSubquery.id === subqueryId,
    );

    if (!subquery) {
      return;
    }

    this.activeQueryIdSignal.set(subquery.id);
    this.selectedTableIdSignal.set(subquery.query.sourceTableIds[0] ?? '');
    this.clearCanvasSelection();
  }

  addSubquery(): void {
    const index = this.report().subqueries.length + 1;
    const id = this.createId('subquery');
    const subquery: QuerySubquery = {
      id,
      name: `Subquery ${index}`,
      alias: `sq${index}`,
      description: '',
      settings: {
        previewLimit: 100,
      },
      query: createEmptyQueryDocument(),
    };

    this.reportSignal.update((report) => ({
      ...report,
      subqueries: [...report.subqueries, subquery],
    }));
    this.activeQueryIdSignal.set(id);
    this.clearCanvasSelection();
    this.markDirty();
  }

  updateSubqueryName(subqueryId: string, name: string): void {
    const nextName = name.trim();

    if (!nextName || !this.isSubqueryNameAvailable(subqueryId, nextName)) {
      return;
    }

    this.reportSignal.update((report) => ({
      ...report,
      subqueries: report.subqueries.map((subquery) =>
        subquery.id === subqueryId ? { ...subquery, name: nextName } : subquery,
      ),
    }));
    this.markDirty();
  }

  updateSubqueryAlias(subqueryId: string, alias: string): void {
    const nextAlias = createSafeSqlAlias(alias);

    if (!nextAlias || !this.isSubqueryAliasAvailable(subqueryId, nextAlias)) {
      return;
    }

    this.reportSignal.update((report) => ({
      ...report,
      subqueries: report.subqueries.map((subquery) =>
        subquery.id === subqueryId ? { ...subquery, alias: nextAlias } : subquery,
      ),
    }));
    this.markDirty();
  }

  updateSubqueryDescription(subqueryId: string, description: string): void {
    this.reportSignal.update((report) => ({
      ...report,
      subqueries: report.subqueries.map((subquery) =>
        subquery.id === subqueryId ? { ...subquery, description } : subquery,
      ),
    }));
    this.markDirty();
  }

  updateSubqueryPreviewLimit(subqueryId: string, previewLimit: number): void {
    const nextPreviewLimit = Math.min(500, Math.max(1, Math.trunc(previewLimit || 100)));

    this.reportSignal.update((report) => ({
      ...report,
      subqueries: report.subqueries.map((subquery) =>
        subquery.id === subqueryId
          ? {
              ...subquery,
              settings: {
                previewLimit: nextPreviewLimit,
              },
            }
          : subquery,
      ),
    }));
    this.markDirty();
  }

  copySubquery(subqueryId: string): void {
    const sourceSubquery = this.report().subqueries.find((subquery) => subquery.id === subqueryId);

    if (!sourceSubquery) {
      return;
    }

    const id = this.createId('subquery');
    const name = createUniqueSubqueryName(`${sourceSubquery.name} Copy`, this.report().subqueries);
    const alias = createUniqueSubqueryAlias(
      `${sourceSubquery.alias}_copy`,
      this.report().subqueries,
    );
    const copiedSubquery: QuerySubquery = {
      ...sourceSubquery,
      id,
      name,
      alias,
      query: cloneQueryDocumentWithNewIds(sourceSubquery.query, (prefix) => this.createId(prefix)),
    };

    this.reportSignal.update((report) => ({
      ...report,
      subqueries: [...report.subqueries, copiedSubquery],
    }));
    this.activeQueryIdSignal.set(id);
    this.selectedTableIdSignal.set(copiedSubquery.query.sourceTableIds[0] ?? '');
    this.clearCanvasSelection();
    this.markDirty();
  }

  wrapSourceTableIntoDerivedTable(tableId: string): void {
    const table = this.tableLookup().get(tableId);
    const activeQuery = this.activeQuery();

    if (
      !table ||
      table.sourceType === 'subquery' ||
      !activeQuery.sourceTableIds.includes(tableId)
    ) {
      return;
    }

    const id = this.createId('subquery');
    const subqueryTableId = this.subqueryDatasource.createTableId(id);
    const name = createUniqueSubqueryName(`${table.label} Derived`, this.report().subqueries);
    const alias = createUniqueSubqueryAlias(`${table.alias}_derived`, this.report().subqueries);
    const fieldIdMap = new Map<string, string>(
      table.fields.map((field) => [field.id, `${subqueryTableId}.${field.name}`] as const),
    );
    const outputAliases = new Set(table.fields.map((field) => field.name.toLowerCase()));
    const additionalOutputColumns = activeQuery.columns
      .filter((column) => this.fieldLookup().get(column.fieldId)?.tableId === table.id)
      .filter((column) => {
        const field = this.fieldLookup().get(column.fieldId);
        const alias = createSafeSqlAlias(column.alias || field?.name || column.id);

        return (
          alias &&
          !outputAliases.has(alias.toLowerCase()) &&
          (!field || !isDefaultColumnExpression(column.expression, field) || alias !== field.name)
        );
      })
      .map((column) => {
        const field = this.fieldLookup().get(column.fieldId);
        const alias = createSafeSqlAlias(column.alias || field?.name || column.id) || column.id;

        outputAliases.add(alias.toLowerCase());

        return {
          id: this.createId('column'),
          fieldId: column.fieldId,
          expression: column.expression,
          alias,
          visible: true,
          sortDirection: 'none' as const,
          groupBy: false,
          criteria: '',
          orCriteria: ['', ''],
        };
      });
    const columnIdMap = new Map<string, string>();

    for (const column of activeQuery.columns) {
      const field = this.fieldLookup().get(column.fieldId);
      const alias = createSafeSqlAlias(column.alias || field?.name || column.id);

      if (
        field?.tableId === table.id &&
        alias &&
        additionalOutputColumns.some((outputColumn) => outputColumn.alias === alias)
      ) {
        columnIdMap.set(column.id, `${subqueryTableId}.${alias}`);
      }
    }

    const subquery: QuerySubquery = {
      id,
      name,
      alias,
      description: `Derived table for ${table.label}`,
      settings: {
        previewLimit: 100,
      },
      query: {
        ...createEmptyQueryDocument(),
        sourceTableIds: [table.id],
        columns: [
          ...table.fields.map((field) => ({
            id: this.createId('column'),
            fieldId: field.id,
            expression: field.expression,
            alias: field.name,
            visible: true,
            sortDirection: 'none' as const,
            groupBy: false,
            criteria: '',
            orCriteria: ['', ''],
          })),
          ...additionalOutputColumns,
        ],
        layout: {
          tables: [{ tableId: table.id, x: 0, y: 0 }],
        },
      },
    };
    const activeQueryId = this.activeQueryId();
    const nextSelection = replaceSelectionTable(
      this.canvasSelection(),
      tableId,
      subqueryTableId,
      fieldIdMap,
    );

    this.reportSignal.update((report) => ({
      ...updateReportQuery(
        {
          ...report,
          subqueries: [...report.subqueries, subquery],
        },
        activeQueryId,
        (query) =>
          replaceQueryTableReferences(query, tableId, subqueryTableId, fieldIdMap, columnIdMap),
      ),
    }));
    this.selectedTableIdSignal.set(subqueryTableId);
    this.canvasSelectionSignal.set(nextSelection);
    this.markDirty();
  }

  removeSubquery(subqueryId: string): void {
    if (!this.canRemoveSubquery(subqueryId)) {
      return;
    }

    const tableId = this.subqueryDatasource.createTableId(subqueryId);

    this.reportSignal.update((report) => ({
      ...report,
      query: removeTableFromQuery(report.query, tableId, this.fieldLookup()),
      subqueries: report.subqueries
        .filter((subquery) => subquery.id !== subqueryId)
        .map((subquery) => ({
          ...subquery,
          query: removeTableFromQuery(subquery.query, tableId, this.fieldLookup()),
        })),
    }));

    if (this.activeQueryId() === subqueryId) {
      this.activeQueryIdSignal.set('main');
      this.clearCanvasSelection();
    }

    this.markDirty();
  }

  useSubqueryInMain(subqueryId: string): void {
    const tableId = this.subqueryDatasource.createTableId(subqueryId);

    if (!this.canUseTableAsSourceInQuery(tableId, 'main')) {
      return;
    }

    this.activeQueryIdSignal.set('main');
    this.selectedTableIdSignal.set(tableId);
    if (this.ensureSourceTable(tableId)) {
      this.markDirty();
    }
    this.selectCanvasTable(tableId);
  }

  subqueryTableId(subqueryId: string): string {
    return this.subqueryDatasource.createTableId(subqueryId);
  }

  canUseTableAsSource(tableId: string): boolean {
    return this.tableLookup().has(tableId) && !this.wouldCreateSubqueryDependencyCycle(tableId);
  }

  canUseTableAsSourceInQuery(tableId: string, queryId: QueryWorkspaceId): boolean {
    return (
      this.tableLookup().has(tableId) && !this.wouldCreateSubqueryDependencyCycle(tableId, queryId)
    );
  }

  isSubqueryNameAvailable(subqueryId: string, name: string): boolean {
    const normalizedName = name.trim().toLowerCase();

    return (
      normalizedName.length > 0 &&
      !this.report().subqueries.some(
        (subquery) =>
          subquery.id !== subqueryId && subquery.name.trim().toLowerCase() === normalizedName,
      )
    );
  }

  isSubqueryAliasAvailable(subqueryId: string, alias: string): boolean {
    const normalizedAlias = createSafeSqlAlias(alias).toLowerCase();

    return (
      normalizedAlias.length > 0 &&
      !this.report().subqueries.some(
        (subquery) =>
          subquery.id !== subqueryId && subquery.alias.toLowerCase() === normalizedAlias,
      )
    );
  }

  subqueryUsedBy(subqueryId: string): readonly string[] {
    const tableId = this.subqueryDatasource.createTableId(subqueryId);
    const usedBy: string[] = [];

    if (this.report().query.sourceTableIds.includes(tableId)) {
      usedBy.push('Main Query');
    }

    for (const subquery of this.report().subqueries) {
      if (subquery.id !== subqueryId && subquery.query.sourceTableIds.includes(tableId)) {
        usedBy.push(subquery.name);
      }
    }

    return usedBy;
  }

  canRemoveSubquery(subqueryId: string): boolean {
    return (
      this.report().subqueries.some((subquery) => subquery.id === subqueryId) &&
      this.subqueryUsedBy(subqueryId).length === 0
    );
  }

  hasSubqueryDependencyCycle(subqueryId: string): boolean {
    return this.validationService.dependsOnSubquery(this.report(), subqueryId, subqueryId);
  }

  setSearchTerm(value: string): void {
    this.searchTermSignal.set(value);
  }

  selectTable(tableId: string): void {
    const table = this.tableLookup().get(tableId);

    if (!table || !this.canUseTableAsSource(tableId)) {
      return;
    }

    this.selectedTableIdSignal.set(tableId);
    if (this.ensureSourceTable(tableId)) {
      this.markDirty();
    }
  }

  addSourceTableAtPosition(
    tableId: string,
    position: Pick<QueryCanvasTablePosition, 'x' | 'y'>,
  ): void {
    if (!this.canUseTableAsSource(tableId)) {
      return;
    }

    this.selectedTableIdSignal.set(tableId);
    this.ensureSourceTable(tableId);
    this.updateCanvasTablePosition(tableId, position);
    this.selectCanvasTable(tableId);
  }

  selectCanvasTable(tableId: string): void {
    const table = this.tableLookup().get(tableId);

    if (!table || !this.activeQuery().sourceTableIds.includes(tableId)) {
      return;
    }

    this.selectedTableIdSignal.set(tableId);
    this.canvasSelectionSignal.set({ kind: 'table', tableId });
  }

  selectCanvasField(fieldId: string): void {
    const field = this.fieldLookup().get(fieldId);

    if (!field || !this.activeQuery().sourceTableIds.includes(field.tableId)) {
      return;
    }

    this.selectedTableIdSignal.set(field.tableId);
    this.canvasSelectionSignal.set({ kind: 'field', fieldId });
  }

  selectCanvasJoin(joinId: string): void {
    if (!this.activeQuery().joins.some((join) => join.id === joinId)) {
      return;
    }

    this.canvasSelectionSignal.set({ kind: 'join', joinId });
  }

  clearCanvasSelection(): void {
    this.canvasSelectionSignal.set({ kind: 'none' });
  }

  removeSourceTable(tableId: string): void {
    const shouldClearSelection = selectionTouchesTable(
      this.canvasSelection(),
      tableId,
      this.fieldLookup(),
      this.activeQuery().joins,
    );

    const activeQueryId = this.activeQueryId();

    this.reportSignal.update((report) => {
      const nextReport = updateReportQuery(report, activeQueryId, (query) =>
        removeTableFromQuery(query, tableId, this.fieldLookup()),
      );

      if (activeQueryId !== 'main') {
        return nextReport;
      }

      const crosstabFieldIds = new Set(
        this.crosstabConfig
          .createOutputFields(nextReport.query.columns, this.fieldLookup())
          .map((field) => field.id),
      );

      return {
        ...nextReport,
        crosstab: {
          ...nextReport.crosstab,
          rowFieldIds: this.crosstabConfig
            .normalizeFieldIds(nextReport.crosstab.rowFieldIds, nextReport.query.columns)
            .filter((fieldId) => crosstabFieldIds.has(fieldId)),
          columnFieldIds: this.crosstabConfig
            .normalizeFieldIds(nextReport.crosstab.columnFieldIds, nextReport.query.columns)
            .filter((fieldId) => crosstabFieldIds.has(fieldId)),
          values: nextReport.crosstab.values.filter((value) =>
            crosstabFieldIds.has(
              this.crosstabConfig.normalizeFieldId(value.fieldId, nextReport.query.columns),
            ),
          ),
        },
      };
    });
    if (shouldClearSelection) {
      this.clearCanvasSelection();
    }
    this.markDirty();
  }

  addColumn(fieldId: string): void {
    const field = this.fieldLookup().get(fieldId);

    if (
      !field ||
      !this.canUseTableAsSource(field.tableId) ||
      this.activeQuery().columns.some((column) => column.fieldId === fieldId)
    ) {
      return;
    }

    this.ensureSourceTable(field.tableId);

    this.updateActiveQuery((query) => ({
      ...query,
      columns: [...query.columns, this.createColumnFromField(field)],
    }));
    this.markDirty();
  }

  addColumnsForTable(tableId: string): void {
    const table = this.tableLookup().get(tableId);

    if (!table || !this.canUseTableAsSource(tableId)) {
      return;
    }

    this.ensureSourceTable(tableId);
    this.updateActiveQuery((query) => {
      const selectedFieldIds = new Set(query.columns.map((column) => column.fieldId));
      const columnsToAdd = table.fields
        .filter((field) => !selectedFieldIds.has(field.id))
        .map((field) => this.createColumnFromField(field));

      if (columnsToAdd.length === 0) {
        return query;
      }

      return {
        ...query,
        columns: [...query.columns, ...columnsToAdd],
      };
    });
    this.markDirty();
  }

  removeColumn(columnId: string): void {
    this.updateActiveQuery((query) => ({
      ...query,
      columns: query.columns.filter((column) => column.id !== columnId),
    }));
    this.markDirty();
  }

  removeColumnByFieldId(fieldId: string): void {
    this.updateActiveQuery((query) => ({
      ...query,
      columns: query.columns.filter((column) => column.fieldId !== fieldId),
    }));
    this.markDirty();
  }

  updateCanvasTablePosition(
    tableId: string,
    position: Pick<QueryCanvasTablePosition, 'x' | 'y'>,
  ): void {
    if (!this.activeQuery().sourceTableIds.includes(tableId)) {
      return;
    }

    const nextPosition: QueryCanvasTablePosition = {
      tableId,
      x: Math.max(0, Math.round(position.x)),
      y: Math.max(0, Math.round(position.y)),
    };
    let changed = false;

    this.updateActiveQuery((query) => {
      const currentPosition = query.layout.tables.find(
        (tablePosition) => tablePosition.tableId === tableId,
      );

      if (
        currentPosition &&
        currentPosition.x === nextPosition.x &&
        currentPosition.y === nextPosition.y
      ) {
        return query;
      }

      changed = true;

      return {
        ...query,
        layout: {
          ...query.layout,
          tables: currentPosition
            ? query.layout.tables.map((tablePosition) =>
                tablePosition.tableId === tableId ? nextPosition : tablePosition,
              )
            : [...query.layout.tables, nextPosition],
        },
      };
    });

    if (changed) {
      this.markDirty();
    }
  }

  addJoin(fromFieldId: string, toFieldId: string, type: QueryJoinType = 'left'): void {
    this.addJoinOrCondition(fromFieldId, toFieldId, type);
  }

  assessJoinDrop(fromFieldId: string, toFieldId: string): JoinDropAssessment {
    return this.joinGraph.assessJoinDrop(
      fromFieldId,
      toFieldId,
      this.activeQuery().joins,
      this.fieldLookup(),
    );
  }

  addJoinOrCondition(
    fromFieldId: string,
    toFieldId: string,
    type: QueryJoinType = 'left',
  ): string | null {
    const assessment = this.assessJoinDrop(fromFieldId, toFieldId);
    const fromField = this.fieldLookup().get(fromFieldId);
    const toField = this.fieldLookup().get(toFieldId);

    if (
      !assessment.canDrop ||
      !fromField ||
      !toField ||
      !this.canUseTableAsSource(fromField.tableId) ||
      !this.canUseTableAsSource(toField.tableId)
    ) {
      return null;
    }

    this.ensureSourceTable(fromField.tableId);
    this.ensureSourceTable(toField.tableId);

    let addedJoinId = '';
    let changedJoinId = '';

    this.updateActiveQuery((query) => {
      const existingJoin = assessment.targetJoinId
        ? query.joins.find((join) => join.id === assessment.targetJoinId)
        : null;

      if (assessment.mode === 'condition' && existingJoin) {
        const conditionCandidate = this.joinGraph.orientJoinConditionForJoin(
          existingJoin,
          fromFieldId,
          toFieldId,
          this.fieldLookup(),
        );

        if (!conditionCandidate) {
          return query;
        }

        changedJoinId = existingJoin.id;

        return {
          ...query,
          joins: query.joins.map((join) =>
            join.id === existingJoin.id
              ? {
                  ...join,
                  conditions: [
                    ...join.conditions,
                    {
                      id: this.createId('join-condition'),
                      ...conditionCandidate,
                    },
                  ],
                }
              : join,
          ),
        };
      }

      addedJoinId = this.createId('join');
      changedJoinId = addedJoinId;

      return {
        ...query,
        joins: [
          ...query.joins,
          {
            id: addedJoinId,
            type,
            conditions: [
              {
                id: this.createId('join-condition'),
                fromFieldId,
                operator: 'equals',
                toFieldId,
              },
            ],
          },
        ],
      };
    });

    if (changedJoinId) {
      this.markDirty();
      this.selectCanvasJoin(changedJoinId);
    }

    return changedJoinId || null;
  }

  removeJoin(joinId: string): void {
    let removed = false;

    this.updateActiveQuery((query) => {
      const joins = query.joins.filter((join) => join.id !== joinId);
      removed = joins.length !== query.joins.length;

      return removed
        ? {
            ...query,
            joins,
          }
        : query;
    });

    if (removed) {
      const selection = this.canvasSelection();

      if (selection.kind === 'join' && selection.joinId === joinId) {
        this.clearCanvasSelection();
      }
      this.markDirty();
    }
  }

  updateJoinType(joinId: string, type: QueryJoinType): void {
    let updated = false;

    this.updateActiveQuery((query) => ({
      ...query,
      joins: query.joins.map((join) => {
        if (join.id !== joinId || join.type === type) {
          return join;
        }

        updated = true;

        return { ...join, type };
      }),
    }));

    if (updated) {
      this.markDirty();
    }
  }

  addJoinCondition(joinId: string): void {
    const join = this.activeQuery().joins.find((currentJoin) => currentJoin.id === joinId);
    const candidate = join
      ? this.joinGraph.findSuggestedJoinCondition(join, this.tableLookup(), this.fieldLookup())
      : null;

    if (!candidate) {
      return;
    }

    const condition: QueryJoinCondition = {
      id: this.createId('join-condition'),
      ...candidate,
    };
    let added = false;

    this.updateActiveQuery((query) => ({
      ...query,
      joins: query.joins.map((currentJoin) => {
        if (currentJoin.id !== joinId) {
          return currentJoin;
        }

        added = true;

        return {
          ...currentJoin,
          conditions: [...currentJoin.conditions, condition],
        };
      }),
    }));

    if (added) {
      this.markDirty();
    }
  }

  canAddJoinCondition(joinId: string): boolean {
    const join = this.activeQuery().joins.find((currentJoin) => currentJoin.id === joinId);

    return join
      ? this.joinGraph.findSuggestedJoinCondition(join, this.tableLookup(), this.fieldLookup()) !==
          null
      : false;
  }

  suggestedJoinConditionLabel(joinId: string): string {
    const join = this.activeQuery().joins.find((currentJoin) => currentJoin.id === joinId);
    const candidate = join
      ? this.joinGraph.findSuggestedJoinCondition(join, this.tableLookup(), this.fieldLookup())
      : null;
    const fromField = candidate ? this.fieldLookup().get(candidate.fromFieldId) : null;
    const toField = candidate ? this.fieldLookup().get(candidate.toFieldId) : null;

    return fromField && toField ? `${fromField.name} = ${toField.name}` : '';
  }

  removeJoinCondition(joinId: string, conditionId: string): void {
    let removed = false;

    this.updateActiveQuery((query) => ({
      ...query,
      joins: query.joins.map((join) => {
        if (join.id !== joinId || join.conditions.length <= 1) {
          return join;
        }

        const conditions = join.conditions.filter((condition) => condition.id !== conditionId);
        removed = conditions.length !== join.conditions.length;

        return removed ? { ...join, conditions } : join;
      }),
    }));

    if (removed) {
      this.markDirty();
    }
  }

  updateJoinConditionFromField(joinId: string, conditionId: string, fieldId: string): void {
    const field = this.fieldLookup().get(fieldId);
    const condition = this.findJoinCondition(joinId, conditionId);
    const toField = condition ? this.fieldLookup().get(condition.toFieldId) : null;

    if (!field || !toField || field.tableId === toField.tableId) {
      return;
    }

    this.updateJoinCondition(joinId, conditionId, { fromFieldId: fieldId });
  }

  updateJoinConditionOperator(
    joinId: string,
    conditionId: string,
    operator: QueryJoinOperator,
  ): void {
    this.updateJoinCondition(joinId, conditionId, { operator });
  }

  updateJoinConditionToField(joinId: string, conditionId: string, fieldId: string): void {
    const field = this.fieldLookup().get(fieldId);
    const condition = this.findJoinCondition(joinId, conditionId);
    const fromField = condition ? this.fieldLookup().get(condition.fromFieldId) : null;

    if (!field || !fromField || field.tableId === fromField.tableId) {
      return;
    }

    this.updateJoinCondition(joinId, conditionId, { toFieldId: fieldId });
  }

  removeColumnsForTable(tableId: string): void {
    this.updateActiveQuery((query) => ({
      ...query,
      columns: query.columns.filter(
        (column) => this.fieldLookup().get(column.fieldId)?.tableId !== tableId,
      ),
    }));
    this.markDirty();
  }

  toggleColumnVisibility(columnId: string, visible: boolean): void {
    this.updateColumn(columnId, { visible });
  }

  updateColumnAlias(columnId: string, alias: string): void {
    this.updateColumn(columnId, { alias });
  }

  updateColumnExpression(columnId: string, expression: string): void {
    const nextExpression = expression.trim();

    if (!nextExpression) {
      return;
    }

    this.updateColumn(columnId, { expression: nextExpression });
  }

  updateColumnSort(columnId: string, sortDirection: SortDirection): void {
    this.updateColumn(columnId, { sortDirection });
  }

  updateColumnGroupBy(columnId: string, groupBy: boolean): void {
    this.updateColumn(columnId, { groupBy });
  }

  updateColumnCriteria(columnId: string, criteria: string): void {
    this.updateColumn(columnId, { criteria });
  }

  updateColumnOrCriteria(columnId: string, index: number, criteria: string): void {
    const column = this.activeQuery().columns.find(
      (currentColumn) => currentColumn.id === columnId,
    );
    const values = [...(column?.orCriteria ?? [])];
    values[index] = criteria;
    this.updateColumn(columnId, { orCriteria: values });
  }

  moveColumn(columnId: string, direction: -1 | 1): void {
    const columns = [...this.activeQuery().columns];
    const currentIndex = columns.findIndex((column) => column.id === columnId);
    const nextIndex = currentIndex + direction;

    if (currentIndex < 0 || nextIndex < 0 || nextIndex >= columns.length) {
      return;
    }

    const [column] = columns.splice(currentIndex, 1);
    if (!column) {
      return;
    }

    columns.splice(nextIndex, 0, column);
    this.updateActiveQuery((query) => ({
      ...query,
      columns,
    }));
    this.markDirty();
  }

  addFilter(fieldId: string): void {
    const field = this.fieldLookup().get(fieldId);

    if (!field || !this.canUseTableAsSource(field.tableId)) {
      return;
    }

    this.ensureSourceTable(field.tableId);
    this.updateActiveQuery((query) => ({
      ...query,
      filters: [
        ...query.filters,
        {
          id: this.createId('filter'),
          fieldId,
          operator: field.type === 'string' ? 'contains' : 'equals',
          value: '',
          parameterName: '',
        },
      ],
    }));
    this.markDirty();
  }

  updateFilterOperator(filterId: string, operator: FilterOperator): void {
    this.updateFilter(filterId, { operator });
  }

  updateFilterValue(filterId: string, value: string): void {
    this.updateFilter(filterId, { value });
  }

  updateFilterParameter(filterId: string, parameterName: string): void {
    this.updateFilter(filterId, { parameterName: normalizeParameterName(parameterName) });
  }

  removeFilter(filterId: string): void {
    this.updateActiveQuery((query) => ({
      ...query,
      filters: query.filters.filter((filter) => filter.id !== filterId),
    }));
    this.markDirty();
  }

  addParameterForFilter(filterId: string): void {
    const filter = this.activeQuery().filters.find(
      (currentFilter) => currentFilter.id === filterId,
    );
    const field = filter ? this.fieldLookup().get(filter.fieldId) : null;

    if (!filter || !field) {
      return;
    }

    const parameterName = createUniqueParameterName(
      createParameterNameFromField(field),
      this.activeQuery().parameters,
    );
    const parameter: QueryParameter = {
      id: this.createId('parameter'),
      name: parameterName,
      label: field.label,
      type: field.type,
      required: true,
      defaultValue: filter.value || defaultParameterValue(field.type),
      kind: 'static',
      lookup: {
        enabled: false,
        multiple: false,
        options: [],
      },
    };

    this.updateActiveQuery((query) => ({
      ...query,
      filters: query.filters.map((currentFilter) =>
        currentFilter.id === filterId
          ? { ...currentFilter, parameterName: parameter.name }
          : currentFilter,
      ),
      parameters: [...query.parameters, parameter],
    }));
    this.markDirty();
  }

  addParameter(): void {
    const parameterName = createUniqueParameterName('Parameter', this.activeQuery().parameters);
    const parameter: QueryParameter = {
      id: this.createId('parameter'),
      name: parameterName,
      label: 'New parameter',
      type: 'string',
      required: false,
      defaultValue: '',
      kind: 'static',
      lookup: {
        enabled: false,
        multiple: false,
        options: [],
      },
    };

    this.updateActiveQuery((query) => ({
      ...query,
      parameters: [...query.parameters, parameter],
    }));
    this.markDirty();
  }

  addDynamicCriteria(fieldId: string): void {
    const field = this.fieldLookup().get(fieldId);

    if (!field || !this.canUseTableAsSource(field.tableId)) {
      return;
    }

    const existingParameter = this.activeQuery().parameters.find(
      (parameter) => parameter.kind === 'dynamic' && parameter.sourceFieldId === fieldId,
    );

    if (existingParameter) {
      return;
    }

    this.ensureSourceTable(field.tableId);
    const parameterName = createUniqueParameterName(
      createParameterNameFromField(field),
      this.activeQuery().parameters,
    );
    const parameter: QueryParameter = {
      id: this.createId('parameter'),
      name: parameterName,
      label: field.label,
      type: field.type,
      required: false,
      defaultValue: '',
      kind: 'dynamic',
      sourceFieldId: field.id,
      lookup: {
        enabled: true,
        multiple: false,
        options: createLookupOptionsForField(field.id, this.previewDataRows()),
      },
    };

    this.updateActiveQuery((query) => ({
      ...query,
      filters: [
        ...query.filters,
        {
          id: this.createId('filter'),
          fieldId,
          operator: 'equals',
          value: '',
          parameterName: parameter.name,
        },
      ],
      parameters: [...query.parameters, parameter],
    }));
    this.markDirty();
  }

  updateParameterName(parameterId: string, name: string): void {
    const parameter = this.activeQuery().parameters.find(
      (currentParameter) => currentParameter.id === parameterId,
    );
    const nextName = normalizeParameterName(name);

    if (!parameter || parameter.name === nextName) {
      return;
    }

    this.updateActiveQuery((query) => ({
      ...query,
      filters: query.filters.map((filter) =>
        filter.parameterName === parameter.name ? { ...filter, parameterName: nextName } : filter,
      ),
      parameters: query.parameters.map((currentParameter) =>
        currentParameter.id === parameterId
          ? { ...currentParameter, name: nextName }
          : currentParameter,
      ),
    }));
    this.markDirty();
  }

  updateParameterLabel(parameterId: string, label: string): void {
    this.updateParameter(parameterId, { label });
  }

  updateParameterType(parameterId: string, type: FieldType): void {
    this.updateParameter(parameterId, { type });
  }

  updateParameterKind(parameterId: string, kind: NonNullable<QueryParameter['kind']>): void {
    const parameter = this.activeQuery().parameters.find(
      (currentParameter) => currentParameter.id === parameterId,
    );

    if (!parameter) {
      return;
    }

    if (kind === 'static') {
      this.updateParameter(parameterId, {
        kind,
        sourceFieldId: undefined,
      });
      return;
    }

    const sourceField =
      this.fieldLookup().get(parameter.sourceFieldId ?? '') ?? this.fieldsForSelectedSources()[0];

    this.updateParameter(parameterId, {
      kind,
      ...(sourceField
        ? {
            sourceFieldId: sourceField.id,
            type: sourceField.type,
            label: sourceField.label,
            lookup: {
              enabled: true,
              multiple: false,
              options: createLookupOptionsForField(sourceField.id, this.previewDataRows()),
            },
          }
        : {}),
    });
  }

  updateParameterSourceField(parameterId: string, fieldId: string): void {
    const field = this.fieldLookup().get(fieldId);

    if (!field) {
      return;
    }

    this.updateParameter(parameterId, {
      sourceFieldId: field.id,
      type: field.type,
      label: field.label,
      lookup: {
        enabled: true,
        multiple: false,
        options: createLookupOptionsForField(field.id, this.previewDataRows()),
      },
    });
  }

  updateParameterRequired(parameterId: string, required: boolean): void {
    this.updateParameter(parameterId, { required });
  }

  updateParameterDefaultValue(parameterId: string, defaultValue: string): void {
    this.updateParameter(parameterId, { defaultValue });
  }

  updateParameterLookupEnabled(parameterId: string, enabled: boolean): void {
    const parameter = this.activeQuery().parameters.find(
      (currentParameter) => currentParameter.id === parameterId,
    );

    if (!parameter) {
      return;
    }

    const sourceFieldId = parameter.sourceFieldId ?? '';
    const generatedOptions =
      parameter.lookup?.options.length || !sourceFieldId
        ? (parameter.lookup?.options ?? [])
        : createLookupOptionsForField(sourceFieldId, this.previewDataRows());

    this.updateParameter(parameterId, {
      lookup: {
        enabled,
        multiple: parameter.lookup?.multiple ?? false,
        options: generatedOptions,
      },
    });
  }

  updateParameterLookupMultiple(parameterId: string, multiple: boolean): void {
    const parameter = this.activeQuery().parameters.find(
      (currentParameter) => currentParameter.id === parameterId,
    );

    if (!parameter) {
      return;
    }

    this.updateParameter(parameterId, {
      lookup: {
        enabled: parameter.lookup?.enabled ?? false,
        multiple,
        options: parameter.lookup?.options ?? [],
      },
    });
  }

  updateParameterLookupOptions(parameterId: string, value: string): void {
    const parameter = this.activeQuery().parameters.find(
      (currentParameter) => currentParameter.id === parameterId,
    );

    if (!parameter) {
      return;
    }

    this.updateParameter(parameterId, {
      lookup: {
        enabled: parameter.lookup?.enabled ?? false,
        multiple: parameter.lookup?.multiple ?? false,
        options: parseLookupOptions(value),
      },
    });
  }

  removeParameter(parameterId: string): void {
    const parameter = this.activeQuery().parameters.find(
      (currentParameter) => currentParameter.id === parameterId,
    );

    if (!parameter) {
      return;
    }

    this.updateActiveQuery((query) => ({
      ...query,
      filters: query.filters.map((filter) =>
        filter.parameterName === parameter.name ? { ...filter, parameterName: '' } : filter,
      ),
      parameters: query.parameters.filter(
        (currentParameter) => currentParameter.id !== parameterId,
      ),
    }));
    this.markDirty();
  }

  addCrosstabRow(fieldId: string): void {
    this.addCrosstabField('rowFieldIds', fieldId);
  }

  addCrosstabColumn(fieldId: string): void {
    this.addCrosstabField('columnFieldIds', fieldId);
  }

  addCrosstabValue(fieldId: string, aggregation: CrosstabAggregation): void {
    const field = this.crosstabFieldLookup().get(fieldId);
    const values = this.crosstabDefinition().values;

    if (
      !field ||
      !field.aggregations.includes(aggregation) ||
      values.some((value) => value.fieldId === fieldId && value.aggregation === aggregation)
    ) {
      return;
    }

    this.reportSignal.update((report) => ({
      ...report,
      crosstab: {
        ...report.crosstab,
        values: [
          ...report.crosstab.values,
          {
            id: this.createId('value'),
            fieldId,
            aggregation,
            label: field.label,
          },
        ],
      },
    }));
    this.markDirty();
  }

  removeCrosstabRow(fieldId: string): void {
    this.removeCrosstabField('rowFieldIds', fieldId);
  }

  removeCrosstabColumn(fieldId: string): void {
    this.removeCrosstabField('columnFieldIds', fieldId);
  }

  removeCrosstabValue(valueId: string): void {
    this.reportSignal.update((report) => ({
      ...report,
      crosstab: {
        ...report.crosstab,
        values: report.crosstab.values.filter((value) => value.id !== valueId),
      },
    }));
    this.markDirty();
  }

  moveCrosstabRow(fieldId: string, direction: -1 | 1): void {
    this.moveCrosstabField('rowFieldIds', fieldId, direction);
  }

  moveCrosstabColumn(fieldId: string, direction: -1 | 1): void {
    this.moveCrosstabField('columnFieldIds', fieldId, direction);
  }

  moveCrosstabValue(valueId: string, direction: -1 | 1): void {
    const values = [...this.crosstabDefinition().values];
    const currentIndex = values.findIndex((value) => value.id === valueId);
    const nextIndex = currentIndex + direction;

    if (currentIndex < 0 || nextIndex < 0 || nextIndex >= values.length) {
      return;
    }

    const [value] = values.splice(currentIndex, 1);

    if (!value) {
      return;
    }

    values.splice(nextIndex, 0, value);
    this.reportSignal.update((report) => ({
      ...report,
      crosstab: {
        ...report.crosstab,
        values,
      },
    }));
    this.markDirty();
  }

  setIncludeRowTotals(includeRowTotals: boolean): void {
    this.reportSignal.update((report) => ({
      ...report,
      crosstab: {
        ...report.crosstab,
        includeRowTotals,
      },
    }));
    this.markDirty();
  }

  setIncludeColumnTotals(includeColumnTotals: boolean): void {
    this.reportSignal.update((report) => ({
      ...report,
      crosstab: {
        ...report.crosstab,
        includeColumnTotals,
      },
    }));
    this.markDirty();
  }

  validateOnServer(): void {
    const validateReport = this.api.validateReport?.bind(this.api);

    if (!validateReport) {
      const issues = this.validationIssues();

      this.serverValidationSignal.set({
        status: issues.length > 0 ? 'invalid' : 'valid',
        issues,
        checkedAt: new Date().toLocaleTimeString(),
        message:
          issues.length > 0
            ? `${issues.length} local validation issue${issues.length === 1 ? '' : 's'}`
            : 'Local validation passed',
      });
      return;
    }

    this.serverValidationSignal.set({
      status: 'checking',
      message: 'Running server validation',
      issues: [],
    });

    validateReport(this.report())
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (response) => {
          this.serverValidationSignal.set({
            status: response.status,
            message: response.message,
            issues: response.issues,
            checkedAt: new Date(response.checkedAt).toLocaleTimeString(),
          });
        },
        error: () => {
          this.serverValidationSignal.set({
            status: 'error',
            message: 'Server validation failed',
            issues: [],
          });
        },
      });
  }

  runServerPreview(limit = 100): void {
    const previewReport = this.api.previewReport?.bind(this.api);
    const request = this.createPreviewRequest(limit);

    if (!previewReport) {
      const issues = this.activeValidationIssues();
      const rows = this.activePreviewRows().slice(0, Math.max(1, limit));

      this.serverPreviewSignal.set({
        status: issues.length > 0 ? 'invalid' : 'ready',
        message:
          issues.length > 0
            ? 'Local preview validation failed'
            : `Local preview returned ${rows.length} row${rows.length === 1 ? '' : 's'}`,
        columns: this.activePreviewColumns(),
        rows,
        issues,
        generatedSql: this.activeSql(),
        executedAt: new Date().toLocaleTimeString(),
      });
      return;
    }

    this.serverPreviewSignal.set({
      status: 'loading',
      message: 'Running server preview',
      columns: [],
      rows: [],
      issues: [],
      generatedSql: '',
    });

    previewReport(request)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (response) => {
          this.serverPreviewSignal.set({
            status: response.status,
            message: response.message,
            columns: response.columns,
            rows: response.rows,
            issues: response.issues,
            generatedSql: response.generatedSql,
            ...(response.executionPlan ? { executionPlan: response.executionPlan } : {}),
            executedAt: new Date(response.executedAt).toLocaleTimeString(),
          });
        },
        error: () => {
          this.serverPreviewSignal.set({
            status: 'error',
            message: 'Server preview failed',
            columns: [],
            rows: [],
            issues: [],
            generatedSql: '',
          });
        },
      });
  }

  save(): void {
    const issues = this.validationIssues();

    if (issues.length > 0) {
      this.saveStateSignal.set({
        status: 'invalid',
        message: `${issues.length} validation issue${issues.length === 1 ? '' : 's'}`,
      });
      return;
    }

    this.saveStateSignal.set({
      status: 'saving',
      message: 'Saving report',
    });

    this.api
      .saveReport(this.report())
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (response) => {
          this.reportSignal.set(response.report);
          this.dirtySignal.set(false);
          this.saveStateSignal.set({
            status: 'saved',
            message: response.message,
            savedAt: new Date(response.savedAt).toLocaleTimeString(),
          });
        },
        error: () => {
          this.saveStateSignal.set({
            status: 'error',
            message: 'Unable to save report',
          });
        },
      });
  }

  private createPreviewRequest(limit: number): QueryPreviewRequest {
    return {
      report: this.report(),
      queryId: this.activeQueryId(),
      limit,
      parameterValues: createParameterValues(this.activeQuery().parameters),
    };
  }

  private updateColumn(columnId: string, patch: Partial<QueryColumn>): void {
    this.updateActiveQuery((query) => ({
      ...query,
      columns: query.columns.map((column) =>
        column.id === columnId ? { ...column, ...patch } : column,
      ),
    }));
    this.markDirty();
  }

  private updateFilter(filterId: string, patch: Partial<QueryFilter>): void {
    this.updateActiveQuery((query) => ({
      ...query,
      filters: query.filters.map((filter) =>
        filter.id === filterId ? { ...filter, ...patch } : filter,
      ),
    }));
    this.markDirty();
  }

  private updateParameter(parameterId: string, patch: Partial<QueryParameter>): void {
    this.updateActiveQuery((query) => ({
      ...query,
      parameters: query.parameters.map((parameter) =>
        parameter.id === parameterId ? { ...parameter, ...patch } : parameter,
      ),
    }));
    this.markDirty();
  }

  private updateActiveQuery(updater: (query: QueryDocument) => QueryDocument): void {
    const activeQueryId = this.activeQueryId();

    this.reportSignal.update((report) => updateReportQuery(report, activeQueryId, updater));
  }

  private updateJoinCondition(
    joinId: string,
    conditionId: string,
    patch: Partial<QueryJoinCondition>,
  ): void {
    let updated = false;

    this.updateActiveQuery((query) => ({
      ...query,
      joins: query.joins.map((join) => {
        if (join.id !== joinId) {
          return join;
        }

        return {
          ...join,
          conditions: join.conditions.map((condition) => {
            if (condition.id !== conditionId) {
              return condition;
            }

            const nextCondition = { ...condition, ...patch };

            if (areJoinConditionsEqual(condition, nextCondition)) {
              return condition;
            }

            updated = true;

            return nextCondition;
          }),
        };
      }),
    }));

    if (updated) {
      this.markDirty();
    }
  }

  private findJoinCondition(joinId: string, conditionId: string): QueryJoinCondition | null {
    return (
      this.activeQuery()
        .joins.find((join) => join.id === joinId)
        ?.conditions.find((condition) => condition.id === conditionId) ?? null
    );
  }

  private addCrosstabField(target: 'rowFieldIds' | 'columnFieldIds', fieldId: string): void {
    const field = this.crosstabFieldLookup().get(fieldId);
    const selectedFieldIds = new Set(
      this.crosstabConfig.normalizeFieldIds(
        this.report().crosstab[target],
        this.report().query.columns,
      ),
    );

    if (!field || selectedFieldIds.has(fieldId)) {
      return;
    }

    this.reportSignal.update((report) => ({
      ...report,
      crosstab: {
        ...report.crosstab,
        [target]: [...report.crosstab[target], fieldId],
      },
    }));
    this.markDirty();
  }

  private removeCrosstabField(target: 'rowFieldIds' | 'columnFieldIds', fieldId: string): void {
    const equivalentFieldIds = this.crosstabConfig.createEquivalentFieldIds(
      fieldId,
      this.report().query.columns,
    );

    this.reportSignal.update((report) => ({
      ...report,
      crosstab: {
        ...report.crosstab,
        [target]: report.crosstab[target].filter(
          (currentFieldId) => !equivalentFieldIds.has(currentFieldId),
        ),
      },
    }));
    this.markDirty();
  }

  private moveCrosstabField(
    target: 'rowFieldIds' | 'columnFieldIds',
    fieldId: string,
    direction: -1 | 1,
  ): void {
    const fieldIds = [
      ...this.crosstabConfig.normalizeFieldIds(
        this.report().crosstab[target],
        this.report().query.columns,
      ),
    ];
    const currentIndex = fieldIds.indexOf(fieldId);
    const nextIndex = currentIndex + direction;

    if (currentIndex < 0 || nextIndex < 0 || nextIndex >= fieldIds.length) {
      return;
    }

    const [currentFieldId] = fieldIds.splice(currentIndex, 1);

    if (!currentFieldId) {
      return;
    }

    fieldIds.splice(nextIndex, 0, currentFieldId);
    this.reportSignal.update((report) => ({
      ...report,
      crosstab: {
        ...report.crosstab,
        [target]: fieldIds,
      },
    }));
    this.markDirty();
  }

  private ensureSourceTable(tableId: string): boolean {
    if (!this.canUseTableAsSource(tableId)) {
      return false;
    }

    if (this.activeQuery().sourceTableIds.includes(tableId)) {
      return false;
    }

    this.updateActiveQuery((query) => ({
      ...query,
      sourceTableIds: [...query.sourceTableIds, tableId],
    }));

    return true;
  }

  private wouldCreateSubqueryDependencyCycle(
    tableId: string,
    targetQueryId: QueryWorkspaceId = this.activeQueryId(),
  ): boolean {
    const candidateSubqueryId = this.subqueryDatasource.parseTableId(tableId);

    if (targetQueryId === 'main' || !candidateSubqueryId) {
      return false;
    }

    return (
      candidateSubqueryId === targetQueryId ||
      this.validationService.dependsOnSubquery(this.report(), candidateSubqueryId, targetQueryId)
    );
  }

  private createId(prefix: string): string {
    const id = `${prefix}-${this.sequence}`;
    this.sequence += 1;

    return id;
  }

  private createColumnFromField(field: DataSourceField): QueryColumn {
    return {
      id: this.createId('column'),
      fieldId: field.id,
      expression: field.expression,
      alias: field.name,
      visible: true,
      sortDirection: 'none',
      groupBy: false,
      criteria: '',
      orCriteria: ['', ''],
    };
  }

  private markDirty(): void {
    this.dirtySignal.set(true);
    this.saveStateSignal.set({
      status: 'idle',
      message: 'Unsaved changes',
    });
    this.serverValidationSignal.set({
      status: 'idle',
      message: 'Server validation is stale',
      issues: [],
    });
    this.serverPreviewSignal.set({
      status: 'idle',
      message: 'Server preview is stale',
      columns: [],
      rows: [],
      issues: [],
      generatedSql: '',
    });
  }
}

function filterMetadata(
  groups: readonly DataSourceGroup[],
  searchTerm: string,
): readonly DataSourceGroup[] {
  const normalizedTerm = searchTerm.trim().toLowerCase();

  if (!normalizedTerm) {
    return groups;
  }

  const filteredGroups: DataSourceGroup[] = [];

  for (const group of groups) {
    const groupMatches = group.label.toLowerCase().includes(normalizedTerm);
    const tables: DataSourceTable[] = [];

    for (const table of group.tables) {
      const tableMatches = table.label.toLowerCase().includes(normalizedTerm);
      const fields = tableMatches
        ? table.fields
        : table.fields.filter((field) => field.label.toLowerCase().includes(normalizedTerm));

      if (groupMatches || tableMatches || fields.length > 0) {
        tables.push({ ...table, fields });
      }
    }

    if (groupMatches || tables.length > 0) {
      filteredGroups.push({ ...group, tables });
    }
  }

  return filteredGroups;
}

function updateReportQuery(
  report: ReportDefinition,
  activeQueryId: QueryWorkspaceId,
  updater: (query: QueryDocument) => QueryDocument,
): ReportDefinition {
  if (activeQueryId === 'main') {
    return {
      ...report,
      query: updater(report.query),
    };
  }

  return {
    ...report,
    subqueries: report.subqueries.map((subquery) =>
      subquery.id === activeQueryId ? { ...subquery, query: updater(subquery.query) } : subquery,
    ),
  };
}

function removeTableFromQuery(
  query: QueryDocument,
  tableId: string,
  fieldLookup: ReadonlyMap<string, DataSourceField>,
): QueryDocument {
  return {
    ...query,
    sourceTableIds: query.sourceTableIds.filter((sourceTableId) => sourceTableId !== tableId),
    columns: query.columns.filter((column) => fieldLookup.get(column.fieldId)?.tableId !== tableId),
    filters: query.filters.filter((filter) => fieldLookup.get(filter.fieldId)?.tableId !== tableId),
    joins: query.joins.filter((join) => !joinTouchesTable(join, tableId, fieldLookup)),
    layout: {
      ...query.layout,
      tables: query.layout.tables.filter((position) => position.tableId !== tableId),
    },
  };
}

function replaceQueryTableReferences(
  query: QueryDocument,
  tableId: string,
  nextTableId: string,
  fieldIdMap: ReadonlyMap<string, string>,
  columnIdMap: ReadonlyMap<string, string>,
): QueryDocument {
  return {
    ...query,
    sourceTableIds: uniqueValues(
      query.sourceTableIds.map((sourceTableId) =>
        sourceTableId === tableId ? nextTableId : sourceTableId,
      ),
    ),
    columns: query.columns.map((column) => {
      const nextFieldId = columnIdMap.get(column.id) ?? fieldIdMap.get(column.fieldId);

      return nextFieldId
        ? {
            ...column,
            fieldId: nextFieldId,
            expression: nextFieldId,
          }
        : column;
    }),
    filters: query.filters.map((filter) => ({
      ...filter,
      fieldId: fieldIdMap.get(filter.fieldId) ?? filter.fieldId,
    })),
    joins: query.joins.map((join) => ({
      ...join,
      conditions: join.conditions.map((condition) => ({
        ...condition,
        fromFieldId: fieldIdMap.get(condition.fromFieldId) ?? condition.fromFieldId,
        toFieldId: fieldIdMap.get(condition.toFieldId) ?? condition.toFieldId,
      })),
    })),
    layout: {
      tables: query.layout.tables.map((position) =>
        position.tableId === tableId ? { ...position, tableId: nextTableId } : position,
      ),
    },
    parameters: query.parameters.map((parameter) => ({
      ...parameter,
      ...(parameter.sourceFieldId && fieldIdMap.has(parameter.sourceFieldId)
        ? { sourceFieldId: fieldIdMap.get(parameter.sourceFieldId) }
        : {}),
    })),
  };
}

function replaceSelectionTable(
  selection: QueryCanvasSelection,
  tableId: string,
  nextTableId: string,
  fieldIdMap: ReadonlyMap<string, string>,
): QueryCanvasSelection {
  if (selection.kind === 'table' && selection.tableId === tableId) {
    return { kind: 'table', tableId: nextTableId };
  }

  if (selection.kind === 'field' && fieldIdMap.has(selection.fieldId)) {
    return { kind: 'field', fieldId: fieldIdMap.get(selection.fieldId) ?? selection.fieldId };
  }

  return selection;
}

function uniqueValues<T>(values: readonly T[]): readonly T[] {
  return Array.from(new Set(values));
}

function normalizeParameterName(name: string): string {
  return name.trim().replace(/^@+/, '').replace(/\s+/g, '_');
}

function createParameterNameFromField(field: DataSourceField): string {
  const baseName = normalizeParameterName(field.name || field.label).replace(/[^A-Za-z0-9_]/g, '_');
  const safeName = /^[A-Za-z]/.test(baseName) ? baseName : `Parameter_${baseName}`;

  return safeName.replace(/_+/g, '_').replace(/_$/g, '') || 'Parameter';
}

function createUniqueParameterName(
  preferredName: string,
  parameters: readonly QueryParameter[],
): string {
  const normalizedName = createSafeParameterName(preferredName);
  const usedNames = new Set(parameters.map((parameter) => parameter.name.toLowerCase()));

  if (!usedNames.has(normalizedName.toLowerCase())) {
    return normalizedName;
  }

  let sequence = 2;
  let candidate = `${normalizedName}${sequence}`;

  while (usedNames.has(candidate.toLowerCase())) {
    sequence += 1;
    candidate = `${normalizedName}${sequence}`;
  }

  return candidate;
}

function createSafeParameterName(name: string): string {
  const normalizedName = normalizeParameterName(name).replace(/[^A-Za-z0-9_]/g, '_');
  const safeName = /^[A-Za-z]/.test(normalizedName)
    ? normalizedName
    : `Parameter_${normalizedName}`;

  return safeName.replace(/_+/g, '_').replace(/_$/g, '') || 'Parameter';
}

function defaultParameterValue(type: FieldType): string {
  switch (type) {
    case 'number':
      return '0';
    case 'boolean':
      return 'true';
    case 'date':
      return '';
    case 'string':
      return '';
  }
}

function createLookupOptionsForField(
  fieldId: string,
  rows: readonly DataRecord[],
): readonly string[] {
  return Array.from(
    new Set(
      rows
        .map((row) => row[fieldId])
        .filter((value): value is string | number | boolean => value !== null && value !== '')
        .map((value) => String(value)),
    ),
  )
    .sort((first, second) => first.localeCompare(second, undefined, { numeric: true }))
    .slice(0, 50);
}

function parseLookupOptions(value: string): readonly string[] {
  return Array.from(
    new Set(
      value
        .split(/[\n,]/)
        .map((option) => option.trim())
        .filter(Boolean),
    ),
  );
}

function createParameterValues(
  parameters: readonly QueryParameter[],
): Readonly<Record<string, string>> {
  return Object.fromEntries(
    parameters.map((parameter) => [parameter.name, parameter.defaultValue] as const),
  );
}

function isDefaultColumnExpression(expression: string, field: DataSourceField): boolean {
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

function cloneQueryDocumentWithNewIds(
  query: QueryDocument,
  createId: (prefix: string) => string,
): QueryDocument {
  return {
    ...query,
    columns: query.columns.map((column) => ({ ...column, id: createId('column') })),
    filters: query.filters.map((filter) => ({ ...filter, id: createId('filter') })),
    joins: query.joins.map((join) => ({
      ...join,
      id: createId('join'),
      conditions: join.conditions.map((condition) => ({
        ...condition,
        id: createId('join-condition'),
      })),
    })),
    parameters: query.parameters.map((parameter) => ({ ...parameter, id: createId('parameter') })),
    layout: {
      tables: query.layout.tables.map((position) => ({ ...position })),
    },
  };
}

function createUniqueSubqueryName(baseName: string, subqueries: readonly QuerySubquery[]): string {
  const normalizedBaseName = baseName.trim() || 'Subquery';
  const existingNames = new Set(subqueries.map((subquery) => subquery.name.trim().toLowerCase()));

  if (!existingNames.has(normalizedBaseName.toLowerCase())) {
    return normalizedBaseName;
  }

  let suffix = 2;
  let candidate = `${normalizedBaseName} ${suffix}`;

  while (existingNames.has(candidate.toLowerCase())) {
    suffix += 1;
    candidate = `${normalizedBaseName} ${suffix}`;
  }

  return candidate;
}

function createUniqueSubqueryAlias(
  baseAlias: string,
  subqueries: readonly QuerySubquery[],
): string {
  const normalizedBaseAlias = createSafeSqlAlias(baseAlias) || 'sq';
  const existingAliases = new Set(
    subqueries.map((subquery) => subquery.alias.trim().toLowerCase()),
  );

  if (!existingAliases.has(normalizedBaseAlias.toLowerCase())) {
    return normalizedBaseAlias;
  }

  let suffix = 2;
  let candidate = `${normalizedBaseAlias}_${suffix}`;

  while (existingAliases.has(candidate.toLowerCase())) {
    suffix += 1;
    candidate = `${normalizedBaseAlias}_${suffix}`;
  }

  return candidate;
}

function createCanvasJoin(
  join: QueryJoin,
  tableLookup: ReadonlyMap<string, DataSourceTable>,
  fieldLookup: ReadonlyMap<string, DataSourceField>,
  duplicatePairJoinIds: ReadonlySet<string>,
  conflictingPairJoinIds: ReadonlySet<string>,
): CanvasJoin | null {
  const duplicateConditionIds = findDuplicateJoinConditionIds(join.conditions);
  const conditions = join.conditions
    .map((condition) =>
      createCanvasJoinCondition(condition, duplicateConditionIds, tableLookup, fieldLookup),
    )
    .filter((condition): condition is CanvasJoinCondition => condition !== null);
  const primaryCondition = conditions[0];

  if (!primaryCondition) {
    return null;
  }

  const issues = [
    ...conditions.flatMap((condition) => condition.issues),
    ...(join.conditions.length === 0
      ? [
          {
            level: 'error',
            message: 'Join must have at least one condition.',
          } satisfies CanvasJoinIssue,
        ]
      : []),
    ...(conditions.length < join.conditions.length
      ? [
          {
            level: 'error',
            message: 'Join contains a condition with missing fields.',
          } satisfies CanvasJoinIssue,
        ]
      : []),
    ...(join.type === 'cross' && conditions.length > 0
      ? [
          {
            level: 'warning',
            message: 'Cross join ignores configured conditions.',
          } satisfies CanvasJoinIssue,
        ]
      : []),
    ...(conflictingPairJoinIds.has(join.id)
      ? [
          {
            level: 'error',
            message: 'Another join between these datasources uses a different join type.',
          } satisfies CanvasJoinIssue,
        ]
      : duplicatePairJoinIds.has(join.id)
        ? [
            {
              level: 'warning',
              message: 'Another join already connects these datasources. Merge conditions here.',
            } satisfies CanvasJoinIssue,
          ]
        : []),
  ];

  return {
    id: join.id,
    fromFieldId: primaryCondition.fromFieldId,
    toFieldId: primaryCondition.toFieldId,
    fromTableId: primaryCondition.fromTableId,
    toTableId: primaryCondition.toTableId,
    fromLabel: primaryCondition.fromLabel,
    toLabel: primaryCondition.toLabel,
    type: join.type,
    conditionCount: join.conditions.length,
    conditions,
    status: statusForIssues(issues),
    issues,
    expression: conditions.map((condition) => condition.expression).join(' AND '),
  };
}

function createCanvasJoinCondition(
  condition: QueryJoinCondition,
  duplicateConditionIds: ReadonlySet<string>,
  tableLookup: ReadonlyMap<string, DataSourceTable>,
  fieldLookup: ReadonlyMap<string, DataSourceField>,
): CanvasJoinCondition | null {
  const fromField = fieldLookup.get(condition.fromFieldId);
  const toField = fieldLookup.get(condition.toFieldId);

  if (!fromField || !toField) {
    return null;
  }

  const fromTable = tableLookup.get(fromField.tableId);
  const toTable = tableLookup.get(toField.tableId);

  if (!fromTable || !toTable) {
    return null;
  }

  const fromLabel = `${fromTable.label}.${fromField.name}`;
  const toLabel = `${toTable.label}.${toField.name}`;
  const issues: CanvasJoinIssue[] = [];

  if (fromField.tableId === toField.tableId) {
    issues.push({
      level: 'error',
      message: 'Condition connects fields from the same datasource.',
      conditionId: condition.id,
    });
  }

  if (duplicateConditionIds.has(condition.id)) {
    issues.push({
      level: 'warning',
      message: 'Duplicate join condition.',
      conditionId: condition.id,
    });
  }

  if (fromField.type !== toField.type) {
    issues.push({
      level: 'warning',
      message: `Type mismatch: ${fromField.type} to ${toField.type}.`,
      conditionId: condition.id,
    });
  }

  return {
    id: condition.id,
    fromFieldId: condition.fromFieldId,
    toFieldId: condition.toFieldId,
    fromTableId: fromField.tableId,
    toTableId: toField.tableId,
    fromLabel,
    toLabel,
    operator: condition.operator,
    status: statusForIssues(issues),
    issues,
    expression: `${fromLabel} ${joinOperatorLabel(condition.operator)} ${toLabel}`,
  };
}

function statusForIssues(issues: readonly CanvasJoinIssue[]): CanvasJoinStatus {
  if (issues.some((issue) => issue.level === 'error')) {
    return 'error';
  }

  return issues.length > 0 ? 'warning' : 'valid';
}

function joinOperatorLabel(operator: QueryJoinOperator): string {
  switch (operator) {
    case 'notEquals':
      return '<>';
    case 'greaterThan':
      return '>';
    case 'greaterThanOrEquals':
      return '>=';
    case 'lessThan':
      return '<';
    case 'lessThanOrEquals':
      return '<=';
    case 'equals':
      return '=';
  }
}

function selectionTouchesTable(
  selection: QueryCanvasSelection,
  tableId: string,
  fieldLookup: ReadonlyMap<string, DataSourceField>,
  joins: readonly QueryJoin[],
): boolean {
  if (selection.kind === 'table') {
    return selection.tableId === tableId;
  }

  if (selection.kind === 'field') {
    return fieldLookup.get(selection.fieldId)?.tableId === tableId;
  }

  if (selection.kind === 'join') {
    const join = joins.find((currentJoin) => currentJoin.id === selection.joinId);

    return join ? joinTouchesTable(join, tableId, fieldLookup) : false;
  }

  return false;
}

function createEmptyReport(): ReportDefinition {
  return {
    id: '',
    tenantName: '',
    reportName: '',
    description: '',
    query: createEmptyQueryDocument(),
    subqueries: [],
    crosstab: {
      rowFieldIds: [],
      columnFieldIds: [],
      values: [],
      includeRowTotals: true,
      includeColumnTotals: true,
    },
  };
}

function createEmptyQueryDocument(): QueryDocument {
  return {
    sourceTableIds: [],
    columns: [],
    filters: [],
    joins: [],
    layout: {
      tables: [],
    },
    parameters: [],
  };
}
