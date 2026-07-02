import { computed, DestroyRef, inject, Injectable, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import {
  CellValue,
  CrosstabAggregation,
  DataRecord,
  DataSourceField,
  DataSourceGroup,
  DataSourceTable,
  FilterOperator,
  PreviewRow,
  QueryColumn,
  QueryCanvasTablePosition,
  QueryFilter,
  QueryJoin,
  QueryJoinCondition,
  QueryJoinOperator,
  QueryJoinType,
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
  readonly canvasSelection = this.canvasSelectionSignal.asReadonly();
  readonly report = this.reportSignal.asReadonly();
  readonly searchTerm = this.searchTermSignal.asReadonly();
  readonly selectedTableId = this.selectedTableIdSignal.asReadonly();
  readonly isDirty = this.dirtySignal.asReadonly();
  readonly loadState = this.loadStateSignal.asReadonly();
  readonly saveState = this.saveStateSignal.asReadonly();

  readonly allTables = computed(() => this.metadata().flatMap((group) => group.tables));
  readonly allFields = computed(() => this.allTables().flatMap((table) => table.fields));
  readonly tableLookup = computed(
    () => new Map(this.allTables().map((table) => [table.id, table] as const)),
  );
  readonly fieldLookup = computed(
    () => new Map(this.allFields().map((field) => [field.id, field] as const)),
  );
  readonly selectedTables = computed(() =>
    this.report()
      .query.sourceTableIds.map((tableId) => this.tableLookup().get(tableId))
      .filter((table): table is DataSourceTable => table !== undefined),
  );
  readonly activeTable = computed(() => this.tableLookup().get(this.selectedTableId()) ?? null);
  readonly selectedColumns = computed(() => this.report().query.columns);
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
  readonly previewColumns = computed(() =>
    this.selectedColumns().filter((column) => column.visible),
  );
  readonly canvasTablePositions = computed(
    () =>
      new Map(
        this.report().query.layout.tables.map((position) => [position.tableId, position] as const),
      ),
  );
  readonly joinedFieldIds = computed(() => {
    const fieldIds = new Set<string>();

    for (const join of this.report().query.joins) {
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
  readonly filteredMetadata = computed(() => filterMetadata(this.metadata(), this.searchTerm()));
  readonly filteredSourceRows = computed(() =>
    applyPromptFilters(this.sourceRowsSignal(), this.report().query.filters),
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
  readonly sql = computed(() =>
    this.sqlBuilder.build(this.report(), this.tableLookup(), this.fieldLookup()),
  );
  readonly validationIssues = computed(() =>
    validateReport(this.report(), this.tableLookup(), this.fieldLookup()),
  );
  readonly canvasJoins = computed(() =>
    this.report()
      .query.joins.map((join) => createCanvasJoin(join, this.tableLookup(), this.fieldLookup()))
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
      this.filteredSourceRows(),
      this.report().crosstab,
      this.fieldLookup(),
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

  setSearchTerm(value: string): void {
    this.searchTermSignal.set(value);
  }

  selectTable(tableId: string): void {
    const table = this.tableLookup().get(tableId);

    if (!table) {
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
    if (!this.tableLookup().has(tableId)) {
      return;
    }

    this.selectedTableIdSignal.set(tableId);
    this.ensureSourceTable(tableId);
    this.updateCanvasTablePosition(tableId, position);
    this.selectCanvasTable(tableId);
  }

  selectCanvasTable(tableId: string): void {
    const table = this.tableLookup().get(tableId);

    if (!table || !this.report().query.sourceTableIds.includes(tableId)) {
      return;
    }

    this.selectedTableIdSignal.set(tableId);
    this.canvasSelectionSignal.set({ kind: 'table', tableId });
  }

  selectCanvasField(fieldId: string): void {
    const field = this.fieldLookup().get(fieldId);

    if (!field || !this.report().query.sourceTableIds.includes(field.tableId)) {
      return;
    }

    this.selectedTableIdSignal.set(field.tableId);
    this.canvasSelectionSignal.set({ kind: 'field', fieldId });
  }

  selectCanvasJoin(joinId: string): void {
    if (!this.report().query.joins.some((join) => join.id === joinId)) {
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
      this.report().query.joins,
    );

    this.reportSignal.update((report) => ({
      ...report,
      query: {
        ...report.query,
        sourceTableIds: report.query.sourceTableIds.filter(
          (sourceTableId) => sourceTableId !== tableId,
        ),
        columns: report.query.columns.filter(
          (column) => this.fieldLookup().get(column.fieldId)?.tableId !== tableId,
        ),
        filters: report.query.filters.filter(
          (filter) => this.fieldLookup().get(filter.fieldId)?.tableId !== tableId,
        ),
        joins: report.query.joins.filter(
          (join) => !joinTouchesTable(join, tableId, this.fieldLookup()),
        ),
        layout: {
          ...report.query.layout,
          tables: report.query.layout.tables.filter((position) => position.tableId !== tableId),
        },
      },
      crosstab: {
        ...report.crosstab,
        rowFieldIds: report.crosstab.rowFieldIds.filter(
          (fieldId) => this.fieldLookup().get(fieldId)?.tableId !== tableId,
        ),
        columnFieldIds: report.crosstab.columnFieldIds.filter(
          (fieldId) => this.fieldLookup().get(fieldId)?.tableId !== tableId,
        ),
        values: report.crosstab.values.filter(
          (value) => this.fieldLookup().get(value.fieldId)?.tableId !== tableId,
        ),
      },
    }));
    if (shouldClearSelection) {
      this.clearCanvasSelection();
    }
    this.markDirty();
  }

  addColumn(fieldId: string): void {
    const field = this.fieldLookup().get(fieldId);

    if (!field || this.report().query.columns.some((column) => column.fieldId === fieldId)) {
      return;
    }

    this.ensureSourceTable(field.tableId);

    this.reportSignal.update((report) => ({
      ...report,
      query: {
        ...report.query,
        columns: [...report.query.columns, this.createColumnFromField(field)],
      },
    }));
    this.markDirty();
  }

  addColumnsForTable(tableId: string): void {
    const table = this.tableLookup().get(tableId);

    if (!table) {
      return;
    }

    this.ensureSourceTable(tableId);
    this.reportSignal.update((report) => {
      const selectedFieldIds = new Set(report.query.columns.map((column) => column.fieldId));
      const columnsToAdd = table.fields
        .filter((field) => !selectedFieldIds.has(field.id))
        .map((field) => this.createColumnFromField(field));

      if (columnsToAdd.length === 0) {
        return report;
      }

      return {
        ...report,
        query: {
          ...report.query,
          columns: [...report.query.columns, ...columnsToAdd],
        },
      };
    });
    this.markDirty();
  }

  removeColumn(columnId: string): void {
    this.reportSignal.update((report) => ({
      ...report,
      query: {
        ...report.query,
        columns: report.query.columns.filter((column) => column.id !== columnId),
      },
    }));
    this.markDirty();
  }

  removeColumnByFieldId(fieldId: string): void {
    this.reportSignal.update((report) => ({
      ...report,
      query: {
        ...report.query,
        columns: report.query.columns.filter((column) => column.fieldId !== fieldId),
      },
    }));
    this.markDirty();
  }

  updateCanvasTablePosition(
    tableId: string,
    position: Pick<QueryCanvasTablePosition, 'x' | 'y'>,
  ): void {
    if (!this.report().query.sourceTableIds.includes(tableId)) {
      return;
    }

    const nextPosition: QueryCanvasTablePosition = {
      tableId,
      x: Math.max(0, Math.round(position.x)),
      y: Math.max(0, Math.round(position.y)),
    };
    let changed = false;

    this.reportSignal.update((report) => {
      const currentPosition = report.query.layout.tables.find(
        (tablePosition) => tablePosition.tableId === tableId,
      );

      if (
        currentPosition &&
        currentPosition.x === nextPosition.x &&
        currentPosition.y === nextPosition.y
      ) {
        return report;
      }

      changed = true;

      return {
        ...report,
        query: {
          ...report.query,
          layout: {
            ...report.query.layout,
            tables: currentPosition
              ? report.query.layout.tables.map((tablePosition) =>
                  tablePosition.tableId === tableId ? nextPosition : tablePosition,
                )
              : [...report.query.layout.tables, nextPosition],
          },
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
      this.report().query.joins,
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

    if (!assessment.canDrop || !fromField || !toField) {
      return null;
    }

    this.ensureSourceTable(fromField.tableId);
    this.ensureSourceTable(toField.tableId);

    let addedJoinId = '';
    let changedJoinId = '';

    this.reportSignal.update((report) => {
      const existingJoin = assessment.targetJoinId
        ? report.query.joins.find((join) => join.id === assessment.targetJoinId)
        : null;

      if (assessment.mode === 'condition' && existingJoin) {
        const conditionCandidate = this.joinGraph.orientJoinConditionForJoin(
          existingJoin,
          fromFieldId,
          toFieldId,
          this.fieldLookup(),
        );

        if (!conditionCandidate) {
          return report;
        }

        changedJoinId = existingJoin.id;

        return {
          ...report,
          query: {
            ...report.query,
            joins: report.query.joins.map((join) =>
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
          },
        };
      }

      addedJoinId = this.createId('join');
      changedJoinId = addedJoinId;

      return {
        ...report,
        query: {
          ...report.query,
          joins: [
            ...report.query.joins,
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
        },
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

    this.reportSignal.update((report) => {
      const joins = report.query.joins.filter((join) => join.id !== joinId);
      removed = joins.length !== report.query.joins.length;

      return removed
        ? {
            ...report,
            query: {
              ...report.query,
              joins,
            },
          }
        : report;
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

    this.reportSignal.update((report) => ({
      ...report,
      query: {
        ...report.query,
        joins: report.query.joins.map((join) => {
          if (join.id !== joinId || join.type === type) {
            return join;
          }

          updated = true;

          return { ...join, type };
        }),
      },
    }));

    if (updated) {
      this.markDirty();
    }
  }

  addJoinCondition(joinId: string): void {
    const join = this.report().query.joins.find((currentJoin) => currentJoin.id === joinId);
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

    this.reportSignal.update((report) => ({
      ...report,
      query: {
        ...report.query,
        joins: report.query.joins.map((currentJoin) => {
          if (currentJoin.id !== joinId) {
            return currentJoin;
          }

          added = true;

          return {
            ...currentJoin,
            conditions: [...currentJoin.conditions, condition],
          };
        }),
      },
    }));

    if (added) {
      this.markDirty();
    }
  }

  canAddJoinCondition(joinId: string): boolean {
    const join = this.report().query.joins.find((currentJoin) => currentJoin.id === joinId);

    return join
      ? this.joinGraph.findSuggestedJoinCondition(join, this.tableLookup(), this.fieldLookup()) !==
          null
      : false;
  }

  suggestedJoinConditionLabel(joinId: string): string {
    const join = this.report().query.joins.find((currentJoin) => currentJoin.id === joinId);
    const candidate = join
      ? this.joinGraph.findSuggestedJoinCondition(join, this.tableLookup(), this.fieldLookup())
      : null;
    const fromField = candidate ? this.fieldLookup().get(candidate.fromFieldId) : null;
    const toField = candidate ? this.fieldLookup().get(candidate.toFieldId) : null;

    return fromField && toField ? `${fromField.name} = ${toField.name}` : '';
  }

  removeJoinCondition(joinId: string, conditionId: string): void {
    let removed = false;

    this.reportSignal.update((report) => ({
      ...report,
      query: {
        ...report.query,
        joins: report.query.joins.map((join) => {
          if (join.id !== joinId || join.conditions.length <= 1) {
            return join;
          }

          const conditions = join.conditions.filter((condition) => condition.id !== conditionId);
          removed = conditions.length !== join.conditions.length;

          return removed ? { ...join, conditions } : join;
        }),
      },
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
    this.reportSignal.update((report) => ({
      ...report,
      query: {
        ...report.query,
        columns: report.query.columns.filter(
          (column) => this.fieldLookup().get(column.fieldId)?.tableId !== tableId,
        ),
      },
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
    const column = this.report().query.columns.find(
      (currentColumn) => currentColumn.id === columnId,
    );
    const values = [...(column?.orCriteria ?? [])];
    values[index] = criteria;
    this.updateColumn(columnId, { orCriteria: values });
  }

  moveColumn(columnId: string, direction: -1 | 1): void {
    const columns = [...this.report().query.columns];
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
    this.reportSignal.update((report) => ({
      ...report,
      query: {
        ...report.query,
        columns,
      },
    }));
    this.markDirty();
  }

  addFilter(fieldId: string): void {
    const field = this.fieldLookup().get(fieldId);

    if (!field) {
      return;
    }

    this.ensureSourceTable(field.tableId);
    this.reportSignal.update((report) => ({
      ...report,
      query: {
        ...report.query,
        filters: [
          ...report.query.filters,
          {
            id: this.createId('filter'),
            fieldId,
            operator: field.type === 'string' ? 'contains' : 'equals',
            value: '',
            parameterName: '',
          },
        ],
      },
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
    this.updateFilter(filterId, { parameterName });
  }

  removeFilter(filterId: string): void {
    this.reportSignal.update((report) => ({
      ...report,
      query: {
        ...report.query,
        filters: report.query.filters.filter((filter) => filter.id !== filterId),
      },
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
    const field = this.fieldLookup().get(fieldId);

    if (!field) {
      return;
    }

    this.ensureSourceTable(field.tableId);
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
    this.reportSignal.update((report) => ({
      ...report,
      query: {
        ...report.query,
        columns: report.query.columns.map((column) =>
          column.id === columnId ? { ...column, ...patch } : column,
        ),
      },
    }));
    this.markDirty();
  }

  private updateFilter(filterId: string, patch: Partial<QueryFilter>): void {
    this.reportSignal.update((report) => ({
      ...report,
      query: {
        ...report.query,
        filters: report.query.filters.map((filter) =>
          filter.id === filterId ? { ...filter, ...patch } : filter,
        ),
      },
    }));
    this.markDirty();
  }

  private updateJoinCondition(
    joinId: string,
    conditionId: string,
    patch: Partial<QueryJoinCondition>,
  ): void {
    let updated = false;

    this.reportSignal.update((report) => ({
      ...report,
      query: {
        ...report.query,
        joins: report.query.joins.map((join) => {
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
      },
    }));

    if (updated) {
      this.markDirty();
    }
  }

  private findJoinCondition(joinId: string, conditionId: string): QueryJoinCondition | null {
    return (
      this.report()
        .query.joins.find((join) => join.id === joinId)
        ?.conditions.find((condition) => condition.id === conditionId) ?? null
    );
  }

  private addCrosstabField(target: 'rowFieldIds' | 'columnFieldIds', fieldId: string): void {
    const field = this.fieldLookup().get(fieldId);

    if (!field || this.report().crosstab[target].includes(fieldId)) {
      return;
    }

    this.ensureSourceTable(field.tableId);
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
    this.reportSignal.update((report) => ({
      ...report,
      crosstab: {
        ...report.crosstab,
        [target]: report.crosstab[target].filter((currentFieldId) => currentFieldId !== fieldId),
      },
    }));
    this.markDirty();
  }

  private ensureSourceTable(tableId: string): boolean {
    if (this.report().query.sourceTableIds.includes(tableId)) {
      return false;
    }

    this.reportSignal.update((report) => ({
      ...report,
      query: {
        ...report.query,
        sourceTableIds: [...report.query.sourceTableIds, tableId],
      },
    }));

    return true;
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

function applyPromptFilters(
  rows: readonly DataRecord[],
  filters: readonly QueryFilter[],
): readonly DataRecord[] {
  return rows.filter((row) =>
    filters.every((filter) => {
      const value = row[filter.fieldId];

      switch (filter.operator) {
        case 'equals':
          return String(value ?? '').toLowerCase() === filter.value.toLowerCase();
        case 'notEquals':
          return String(value ?? '').toLowerCase() !== filter.value.toLowerCase();
        case 'contains':
          return String(value ?? '')
            .toLowerCase()
            .includes(filter.value.toLowerCase());
        case 'greaterThan':
          return Number(value) > Number(filter.value);
        case 'lessThan':
          return Number(value) < Number(filter.value);
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

  for (const value of report.crosstab.values) {
    const field = fieldLookup.get(value.fieldId);

    if (!field) {
      issues.push(`Crosstab value ${value.label} points to a missing field.`);
    } else if (!report.query.sourceTableIds.includes(field.tableId)) {
      issues.push(`Crosstab value ${value.label} uses an unselected datasource.`);
    } else if (!field.aggregations.includes(value.aggregation)) {
      issues.push(`${value.aggregation.toUpperCase()} is not supported for ${field.label}.`);
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
    query: {
      sourceTableIds: [],
      columns: [],
      filters: [],
      joins: [],
      layout: {
        tables: [],
      },
      parameters: [],
    },
    crosstab: {
      rowFieldIds: [],
      columnFieldIds: [],
      values: [],
      includeRowTotals: true,
      includeColumnTotals: true,
    },
  };
}
