import { computed, DestroyRef, inject, Injectable, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import {
  CellValue,
  CrosstabAggregation,
  CrosstabDefinition,
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
import { QUERY_EDITOR_API } from './query-editor-api.service';
import {
  areJoinConditionsEqual,
  findDuplicateJoinConditionIds,
  JoinDropAssessment,
  joinTouchesTable,
  QueryJoinGraphService,
} from './query-join-graph.service';
import { QuerySqlBuilderService } from './query-sql-builder.service';

export type { JoinDropAssessment, JoinDropMode } from './query-join-graph.service';

interface EditorLoadState {
  readonly status: 'loading' | 'ready' | 'error';
  readonly message: string;
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
  private readonly crosstabEngine = inject(CrosstabEngineService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly joinGraph = inject(QueryJoinGraphService);
  private readonly sqlBuilder = inject(QuerySqlBuilderService);
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
      createSubqueryTable(subquery, this.baseFieldLookup()),
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
    createPreviewDataRows(this.sourceRowsSignal(), this.report(), this.baseFieldLookup()),
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
    applyPromptFilters(
      this.previewDataRows(),
      this.report().query.filters,
      this.report().query.parameters,
    ),
  );
  readonly activeFilteredSourceRows = computed(() =>
    applyPromptFilters(
      this.previewDataRows(),
      this.activeQuery().filters,
      this.activeQuery().parameters,
    ),
  );
  readonly previewSourceRows = computed(() =>
    sortRows(
      applyColumnCriteria(this.filteredSourceRows(), this.report().query.columns),
      this.report().query.columns,
    ),
  );
  readonly previewRows = computed(() =>
    projectRows(this.previewSourceRows(), this.previewColumns()),
  );
  readonly crosstabFields = computed(() =>
    createCrosstabOutputFields(this.report().query.columns, this.fieldLookup()),
  );
  readonly crosstabFieldLookup = computed(
    () => new Map(this.crosstabFields().map((field) => [field.id, field] as const)),
  );
  readonly crosstabDefinition = computed(() =>
    normalizeCrosstabDefinition(this.report().crosstab, this.report().query.columns),
  );
  readonly renderableCrosstabDefinition = computed(() =>
    createRenderableCrosstabDefinition(this.crosstabDefinition(), this.crosstabFieldLookup()),
  );
  readonly crosstabConfigIssues = computed(() =>
    createCrosstabConfigIssues(this.crosstabDefinition(), this.crosstabFieldLookup()),
  );
  readonly crosstabRows = computed(() =>
    projectRows(this.previewSourceRows(), this.report().query.columns).map((row) => ({
      id: row.id,
      ...row.cells,
    })),
  );
  readonly activePreviewSourceRows = computed(() =>
    sortRows(
      applyColumnCriteria(this.activeFilteredSourceRows(), this.activeQuery().columns),
      this.activeQuery().columns,
    ),
  );
  readonly activePreviewRows = computed(() =>
    projectRows(this.activePreviewSourceRows(), this.activePreviewColumns()),
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
    validateReport(this.report(), this.tableLookup(), this.fieldLookup()),
  );
  readonly activeValidationIssues = computed(() =>
    validateActiveQuery(
      this.activeQuery(),
      this.activeSubquery(),
      this.report(),
      this.tableLookup(),
      this.fieldLookup(),
    ),
  );
  readonly canvasJoins = computed(() =>
    this.activeQuery()
      .joins.map((join) => createCanvasJoin(join, this.tableLookup(), this.fieldLookup()))
      .filter((join): join is CanvasJoin => join !== null),
  );
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

    if (!nextName) {
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

    if (!nextAlias) {
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

  removeSubquery(subqueryId: string): void {
    const tableId = createSubqueryTableId(subqueryId);

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

  subqueryTableId(subqueryId: string): string {
    return createSubqueryTableId(subqueryId);
  }

  canUseTableAsSource(tableId: string): boolean {
    return this.tableLookup().has(tableId) && !this.wouldCreateSubqueryDependencyCycle(tableId);
  }

  hasSubqueryDependencyCycle(subqueryId: string): boolean {
    return dependsOnSubquery(this.report(), subqueryId, subqueryId);
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
        createCrosstabOutputFields(nextReport.query.columns, this.fieldLookup()).map(
          (field) => field.id,
        ),
      );

      return {
        ...nextReport,
        crosstab: {
          ...nextReport.crosstab,
          rowFieldIds: normalizeCrosstabFieldIds(
            nextReport.crosstab.rowFieldIds,
            nextReport.query.columns,
          ).filter((fieldId) => crosstabFieldIds.has(fieldId)),
          columnFieldIds: normalizeCrosstabFieldIds(
            nextReport.crosstab.columnFieldIds,
            nextReport.query.columns,
          ).filter((fieldId) => crosstabFieldIds.has(fieldId)),
          values: nextReport.crosstab.values.filter((value) =>
            crosstabFieldIds.has(normalizeCrosstabFieldId(value.fieldId, nextReport.query.columns)),
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
    };

    this.updateActiveQuery((query) => ({
      ...query,
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

  updateParameterRequired(parameterId: string, required: boolean): void {
    this.updateParameter(parameterId, { required });
  }

  updateParameterDefaultValue(parameterId: string, defaultValue: string): void {
    this.updateParameter(parameterId, { defaultValue });
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
      normalizeCrosstabFieldIds(this.report().crosstab[target], this.report().query.columns),
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
    const equivalentFieldIds = createCrosstabEquivalentFieldIds(
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
      ...normalizeCrosstabFieldIds(this.report().crosstab[target], this.report().query.columns),
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

  private wouldCreateSubqueryDependencyCycle(tableId: string): boolean {
    const activeQueryId = this.activeQueryId();
    const candidateSubqueryId = parseSubqueryTableId(tableId);

    if (activeQueryId === 'main' || !candidateSubqueryId) {
      return false;
    }

    return (
      candidateSubqueryId === activeQueryId ||
      dependsOnSubquery(this.report(), candidateSubqueryId, activeQueryId)
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

function createSubqueryTable(
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

function createSubqueryTableId(subqueryId: string): string {
  return `subquery:${subqueryId}`;
}

function parseSubqueryTableId(tableId: string): string | null {
  return tableId.startsWith('subquery:') ? tableId.slice('subquery:'.length) : null;
}

function dependsOnSubquery(
  report: ReportDefinition,
  sourceSubqueryId: string,
  targetSubqueryId: string,
  visitedSubqueryIds: ReadonlySet<string> = new Set(),
): boolean {
  if (visitedSubqueryIds.has(sourceSubqueryId)) {
    return false;
  }

  const sourceSubquery = report.subqueries.find((subquery) => subquery.id === sourceSubqueryId);

  if (!sourceSubquery) {
    return false;
  }

  const nextVisitedSubqueryIds = new Set(visitedSubqueryIds);
  nextVisitedSubqueryIds.add(sourceSubqueryId);

  return sourceSubquery.query.sourceTableIds.some((tableId) => {
    const dependencySubqueryId = parseSubqueryTableId(tableId);

    if (!dependencySubqueryId) {
      return false;
    }

    return (
      dependencySubqueryId === targetSubqueryId ||
      dependsOnSubquery(report, dependencySubqueryId, targetSubqueryId, nextVisitedSubqueryIds)
    );
  });
}

function createPreviewDataRows(
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

function applyPromptFilters(
  rows: readonly DataRecord[],
  filters: readonly QueryFilter[],
  parameters: readonly QueryParameter[],
): readonly DataRecord[] {
  const parameterLookup = new Map(parameters.map((parameter) => [parameter.name, parameter]));

  return rows.filter((row) =>
    filters.every((filter) => {
      const value = row[filter.fieldId];
      const filterValue =
        filter.operator === 'isEmpty'
          ? ''
          : (parameterLookup.get(filter.parameterName)?.defaultValue ?? filter.value);

      switch (filter.operator) {
        case 'equals':
          return String(value ?? '').toLowerCase() === filterValue.toLowerCase();
        case 'notEquals':
          return String(value ?? '').toLowerCase() !== filterValue.toLowerCase();
        case 'contains':
          return String(value ?? '')
            .toLowerCase()
            .includes(filterValue.toLowerCase());
        case 'greaterThan':
          return Number(value) > Number(filterValue);
        case 'lessThan':
          return Number(value) < Number(filterValue);
        case 'isEmpty':
          return value === null || value === '';
      }
    }),
  );
}

function applyColumnCriteria(
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

function sortRows(
  rows: readonly DataRecord[],
  columns: readonly QueryColumn[],
): readonly DataRecord[] {
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

function projectRows(
  rows: readonly DataRecord[],
  columns: readonly QueryColumn[],
): readonly PreviewRow[] {
  return rows.map((row) => ({
    id: row.id,
    cells: Object.fromEntries(columns.map((column) => [column.id, row[column.fieldId] ?? null])),
  }));
}

function createCrosstabOutputFields(
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

function normalizeCrosstabDefinition(
  definition: CrosstabDefinition,
  columns: readonly QueryColumn[],
): CrosstabDefinition {
  return {
    ...definition,
    rowFieldIds: normalizeCrosstabFieldIds(definition.rowFieldIds, columns),
    columnFieldIds: normalizeCrosstabFieldIds(definition.columnFieldIds, columns),
    values: definition.values.map((value) => ({
      ...value,
      fieldId: normalizeCrosstabFieldId(value.fieldId, columns),
    })),
  };
}

function normalizeCrosstabFieldIds(
  fieldIds: readonly string[],
  columns: readonly QueryColumn[],
): readonly string[] {
  return fieldIds.map((fieldId) => normalizeCrosstabFieldId(fieldId, columns));
}

function normalizeCrosstabFieldId(fieldId: string, columns: readonly QueryColumn[]): string {
  return columns.find((column) => column.fieldId === fieldId)?.id ?? fieldId;
}

function createCrosstabEquivalentFieldIds(
  fieldId: string,
  columns: readonly QueryColumn[],
): ReadonlySet<string> {
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

function createRenderableCrosstabDefinition(
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

function createCrosstabConfigIssues(
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

function createCanvasJoin(
  join: QueryJoin,
  tableLookup: ReadonlyMap<string, DataSourceTable>,
  fieldLookup: ReadonlyMap<string, DataSourceField>,
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

function validateActiveQuery(
  query: QueryDocument,
  subquery: QuerySubquery | null,
  report: ReportDefinition,
  tableLookup: ReadonlyMap<string, DataSourceTable>,
  fieldLookup: ReadonlyMap<string, DataSourceField>,
): readonly string[] {
  const issues = [
    ...validateQueryDocument(query, subquery?.name ?? 'Main query', tableLookup, fieldLookup, {
      selfSourceTableId: subquery ? createSubqueryTableId(subquery.id) : '',
      requireVisibleOutputColumn: subquery !== null,
    }),
  ];

  if (subquery && dependsOnSubquery(report, subquery.id, subquery.id)) {
    issues.push(`${subquery.name}: circular subquery datasource dependency.`);
  }

  return issues;
}

function validateQueryDocument(
  query: QueryDocument,
  label: string,
  tableLookup: ReadonlyMap<string, DataSourceTable>,
  fieldLookup: ReadonlyMap<string, DataSourceField>,
  options: {
    readonly selfSourceTableId?: string;
    readonly requireVisibleOutputColumn?: boolean;
  } = {},
): readonly string[] {
  const issues: string[] = [];
  const aliases = new Set<string>();
  const parameterNames = new Set<string>();

  if (query.sourceTableIds.length === 0) {
    issues.push(`${label}: select at least one datasource table.`);
  }

  if (query.columns.length === 0) {
    issues.push(`${label}: add at least one query column.`);
  }

  if (options.requireVisibleOutputColumn && !query.columns.some((column) => column.visible)) {
    issues.push(`${label}: select at least one visible output column.`);
  }

  for (const tableId of query.sourceTableIds) {
    if (options.selfSourceTableId && tableId === options.selfSourceTableId) {
      issues.push(`${label}: cannot use itself as a datasource.`);
    } else if (!tableLookup.has(tableId)) {
      issues.push(`${label}: datasource ${tableId} is no longer available.`);
    }
  }

  for (const column of query.columns) {
    const field = fieldLookup.get(column.fieldId);

    if (!field) {
      issues.push(`${label}: column ${column.alias} points to a missing field.`);
    } else if (!query.sourceTableIds.includes(field.tableId)) {
      issues.push(`${label}: column ${column.alias} uses an unselected datasource.`);
    }

    const normalizedAlias = column.alias.trim().toLowerCase();

    if (!normalizedAlias) {
      issues.push(`${label}: column aliases cannot be empty.`);
    } else if (aliases.has(normalizedAlias)) {
      issues.push(`${label}: column alias ${column.alias} is duplicated.`);
    } else {
      aliases.add(normalizedAlias);
    }
  }

  for (const filter of query.filters) {
    const field = fieldLookup.get(filter.fieldId);

    if (!field) {
      issues.push(`${label}: filter ${filter.id} points to a missing field.`);
    } else if (!query.sourceTableIds.includes(field.tableId)) {
      issues.push(`${label}: filter on ${field.label} uses an unselected datasource.`);
    }

    if (filter.parameterName && !/^[A-Za-z][A-Za-z0-9_]*$/.test(filter.parameterName)) {
      issues.push(
        `${label}: parameter ${filter.parameterName} must start with a letter and use letters, numbers, or underscores.`,
      );
    } else if (
      filter.parameterName &&
      !query.parameters.some((parameter) => parameter.name === filter.parameterName)
    ) {
      issues.push(
        `${label}: filter on ${field?.label ?? filter.id} uses a missing prompt parameter.`,
      );
    }
  }

  for (const parameter of query.parameters) {
    const normalizedName = parameter.name.trim();

    if (!normalizedName) {
      issues.push(`${label}: prompt parameter names cannot be empty.`);
    } else if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(normalizedName)) {
      issues.push(
        `${label}: parameter ${parameter.name} must start with a letter and use letters, numbers, or underscores.`,
      );
    } else if (parameterNames.has(normalizedName.toLowerCase())) {
      issues.push(`${label}: parameter ${parameter.name} is duplicated.`);
    } else {
      parameterNames.add(normalizedName.toLowerCase());
    }

    if (!parameter.label.trim()) {
      issues.push(`${label}: parameter ${parameter.name || parameter.id} label cannot be empty.`);
    }
  }

  for (const join of query.joins) {
    if (join.conditions.length === 0) {
      issues.push(`${label}: join ${join.id} must have at least one condition.`);
      continue;
    }

    for (const condition of join.conditions) {
      const fromField = fieldLookup.get(condition.fromFieldId);
      const toField = fieldLookup.get(condition.toFieldId);

      if (!fromField || !toField) {
        issues.push(`${label}: join ${join.id} points to a missing field.`);
        continue;
      }

      if (fromField.tableId === toField.tableId) {
        issues.push(`${label}: join ${join.id} connects fields from the same datasource.`);
      }

      if (
        !query.sourceTableIds.includes(fromField.tableId) ||
        !query.sourceTableIds.includes(toField.tableId)
      ) {
        issues.push(`${label}: join ${join.id} uses an unselected datasource.`);
      }
    }
  }

  return issues;
}

function validateReport(
  report: ReportDefinition,
  tableLookup: ReadonlyMap<string, DataSourceTable>,
  fieldLookup: ReadonlyMap<string, DataSourceField>,
): readonly string[] {
  const issues: string[] = [];

  if (report.query.sourceTableIds.length === 0) {
    issues.push('Select at least one datasource table.');
  }

  if (report.query.columns.length === 0) {
    issues.push('Add at least one query column.');
  }

  for (const tableId of report.query.sourceTableIds) {
    if (!tableLookup.has(tableId)) {
      issues.push(`Datasource ${tableId} is no longer available.`);
    }
  }

  const aliases = new Set<string>();
  const parameterNames = new Set<string>();

  for (const column of report.query.columns) {
    const field = fieldLookup.get(column.fieldId);

    if (!field) {
      issues.push(`Column ${column.alias} points to a missing field.`);
    } else if (!report.query.sourceTableIds.includes(field.tableId)) {
      issues.push(`Column ${column.alias} uses a field from an unselected datasource.`);
    }

    const normalizedAlias = column.alias.trim().toLowerCase();

    if (!normalizedAlias) {
      issues.push('Column aliases cannot be empty.');
    } else if (aliases.has(normalizedAlias)) {
      issues.push(`Column alias ${column.alias} is duplicated.`);
    } else {
      aliases.add(normalizedAlias);
    }
  }

  for (const filter of report.query.filters) {
    const field = fieldLookup.get(filter.fieldId);

    if (!field) {
      issues.push(`Filter ${filter.id} points to a missing field.`);
    } else if (!report.query.sourceTableIds.includes(field.tableId)) {
      issues.push(`Filter on ${field.label} uses an unselected datasource.`);
    }

    if (filter.parameterName && !/^[A-Za-z][A-Za-z0-9_]*$/.test(filter.parameterName)) {
      issues.push(
        `Parameter ${filter.parameterName} must start with a letter and use letters, numbers, or underscores.`,
      );
    } else if (
      filter.parameterName &&
      !report.query.parameters.some((parameter) => parameter.name === filter.parameterName)
    ) {
      issues.push(`Filter on ${field?.label ?? filter.id} uses a missing prompt parameter.`);
    }
  }

  for (const parameter of report.query.parameters) {
    const normalizedName = parameter.name.trim();

    if (!normalizedName) {
      issues.push('Prompt parameter names cannot be empty.');
    } else if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(normalizedName)) {
      issues.push(
        `Parameter ${parameter.name} must start with a letter and use letters, numbers, or underscores.`,
      );
    } else if (parameterNames.has(normalizedName.toLowerCase())) {
      issues.push(`Parameter ${parameter.name} is duplicated.`);
    } else {
      parameterNames.add(normalizedName.toLowerCase());
    }

    if (!parameter.label.trim()) {
      issues.push(`Parameter ${parameter.name || parameter.id} label cannot be empty.`);
    }
  }

  for (const join of report.query.joins) {
    if (join.conditions.length === 0) {
      issues.push(`Join ${join.id} must have at least one condition.`);
      continue;
    }

    for (const condition of join.conditions) {
      const fromField = fieldLookup.get(condition.fromFieldId);
      const toField = fieldLookup.get(condition.toFieldId);

      if (!fromField || !toField) {
        issues.push(`Join ${join.id} points to a missing field.`);
        continue;
      }

      if (fromField.tableId === toField.tableId) {
        issues.push(`Join ${join.id} connects fields from the same datasource.`);
      }

      if (
        !report.query.sourceTableIds.includes(fromField.tableId) ||
        !report.query.sourceTableIds.includes(toField.tableId)
      ) {
        issues.push(`Join ${join.id} uses an unselected datasource.`);
      }
    }
  }

  const crosstabDefinition = normalizeCrosstabDefinition(report.crosstab, report.query.columns);
  const crosstabFieldLookup = new Map(
    createCrosstabOutputFields(report.query.columns, fieldLookup).map(
      (field) => [field.id, field] as const,
    ),
  );

  for (const fieldId of crosstabDefinition.rowFieldIds) {
    if (!crosstabFieldLookup.has(fieldId)) {
      issues.push(`Crosstab row field ${fieldId} is not a Main query column.`);
    }
  }

  for (const fieldId of crosstabDefinition.columnFieldIds) {
    if (!crosstabFieldLookup.has(fieldId)) {
      issues.push(`Crosstab column field ${fieldId} is not a Main query column.`);
    }
  }

  for (const value of crosstabDefinition.values) {
    const field = crosstabFieldLookup.get(value.fieldId);

    if (!field) {
      issues.push(`Crosstab value ${value.label} is not a Main query column.`);
    } else if (!field.aggregations.includes(value.aggregation)) {
      issues.push(`${value.aggregation.toUpperCase()} is not supported for ${field.label}.`);
    }
  }

  const subqueryAliases = new Set<string>();

  for (const subquery of report.subqueries) {
    const alias = subquery.alias.trim().toLowerCase();

    if (!subquery.name.trim()) {
      issues.push(`Subquery ${subquery.id} name cannot be empty.`);
    }

    if (!alias) {
      issues.push(`Subquery ${subquery.name} alias cannot be empty.`);
    } else if (subqueryAliases.has(alias)) {
      issues.push(`Subquery alias ${subquery.alias} is duplicated.`);
    } else {
      subqueryAliases.add(alias);
    }

    if (subquery.query.sourceTableIds.length === 0) {
      issues.push(`Subquery ${subquery.name} must select at least one datasource table.`);
    }

    if (dependsOnSubquery(report, subquery.id, subquery.id)) {
      issues.push(`Subquery ${subquery.name} has a circular datasource dependency.`);
    }

    if (!subquery.query.columns.some((column) => column.visible)) {
      issues.push(`Subquery ${subquery.name} must expose at least one visible output column.`);
    }

    for (const tableId of subquery.query.sourceTableIds) {
      if (tableId === createSubqueryTableId(subquery.id)) {
        issues.push(`Subquery ${subquery.name} cannot use itself as a datasource.`);
      } else if (!tableLookup.has(tableId)) {
        issues.push(`Subquery ${subquery.name} uses a missing datasource ${tableId}.`);
      }
    }

    for (const column of subquery.query.columns) {
      const field = fieldLookup.get(column.fieldId);

      if (!field) {
        issues.push(`Subquery ${subquery.name} column ${column.alias} points to a missing field.`);
      } else if (!subquery.query.sourceTableIds.includes(field.tableId)) {
        issues.push(
          `Subquery ${subquery.name} column ${column.alias} uses an unselected datasource.`,
        );
      }
    }

    for (const join of subquery.query.joins) {
      if (join.conditions.length === 0) {
        issues.push(`Subquery ${subquery.name} join ${join.id} must have at least one condition.`);
        continue;
      }

      for (const condition of join.conditions) {
        const fromField = fieldLookup.get(condition.fromFieldId);
        const toField = fieldLookup.get(condition.toFieldId);

        if (!fromField || !toField) {
          issues.push(`Subquery ${subquery.name} join ${join.id} points to a missing field.`);
          continue;
        }

        if (fromField.tableId === toField.tableId) {
          issues.push(`Subquery ${subquery.name} join ${join.id} connects the same datasource.`);
        }
      }
    }
  }

  return issues;
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
