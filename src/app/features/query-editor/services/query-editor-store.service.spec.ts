import { TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import { DATA_SOURCE_GROUPS, MOCK_REPORT, MOCK_ROWS } from '../data/mock-report-data';
import { ReportDefinition } from '../models/report-definition.model';
import { QUERY_EDITOR_API, QueryEditorApi } from './query-editor-api.service';
import { QueryEditorStore } from './query-editor-store.service';

describe('QueryEditorStore join graph behavior', () => {
  let store: QueryEditorStore;

  beforeEach(() => {
    const api: QueryEditorApi = {
      loadReport: () =>
        of({
          metadata: cloneValue(DATA_SOURCE_GROUPS),
          report: cloneValue(MOCK_REPORT),
          rows: cloneValue(MOCK_ROWS),
        }),
      saveReport: (report: ReportDefinition) =>
        of({
          report: cloneValue(report),
          savedAt: '2026-07-01T00:00:00.000Z',
          message: 'Saved',
        }),
    };

    TestBed.configureTestingModule({
      providers: [{ provide: QUERY_EDITOR_API, useValue: api }],
    });
    store = TestBed.inject(QueryEditorStore);
  });

  afterEach(() => {
    TestBed.resetTestingModule();
  });

  it('assesses a new table pair as a new join', () => {
    const assessment = store.assessJoinDrop('Encounter.EncounterId', 'Diagnosis.EncounterId');

    expect(assessment).toEqual({
      mode: 'create',
      canDrop: true,
      message: 'Create join.',
    });
  });

  it('creates a new join and adds both source tables', () => {
    const joinId = store.addJoinOrCondition('Encounter.EncounterId', 'Diagnosis.EncounterId');
    const join = store.report().query.joins.find((currentJoin) => currentJoin.id === joinId);

    expect(joinId).toBeTruthy();
    expect(store.report().query.sourceTableIds).toContain('Diagnosis');
    expect(join?.conditions).toEqual([
      {
        id: expect.any(String),
        fromFieldId: 'Encounter.EncounterId',
        operator: 'equals',
        toFieldId: 'Diagnosis.EncounterId',
      },
    ]);
    expect(store.canvasSelection()).toEqual({ kind: 'join', joinId });
  });

  it('marks the report dirty when selecting a new datasource table', () => {
    expect(store.report().query.sourceTableIds).not.toContain('Diagnosis');
    expect(store.isDirty()).toBe(false);

    store.selectTable('Diagnosis');

    expect(store.report().query.sourceTableIds).toContain('Diagnosis');
    expect(store.isDirty()).toBe(true);
    expect(store.saveState().message).toBe('Unsaved changes');
  });

  it('filters preview rows with column criteria and OR criteria', () => {
    store.updateColumnCriteria('column-provider', 'Dr. Nguyen');

    expect(store.previewRows().map((row) => row.cells['column-provider'])).toEqual([
      'Dr. Nguyen',
      'Dr. Nguyen',
      'Dr. Nguyen',
    ]);

    store.updateColumnOrCriteria('column-provider', 0, 'Dr. Harper');

    expect(store.previewRows().map((row) => row.cells['column-provider'])).toEqual([
      'Dr. Harper',
      'Dr. Nguyen',
      'Dr. Harper',
      'Dr. Harper',
      'Dr. Nguyen',
      'Dr. Nguyen',
    ]);
  });

  it('uses prompt parameter defaults when filtering preview rows', () => {
    store.updateFilterOperator('filter-status', 'equals');
    store.updateFilterValue('filter-status', 'Completed');
    store.addParameterForFilter('filter-status');
    const parameter = store
      .report()
      .query.parameters.find((currentParameter) => currentParameter.name === 'Status');

    expect(parameter).toBeTruthy();
    store.updateParameterDefaultValue(parameter?.id ?? '', 'Pending');

    expect(store.previewRows().map((row) => row.cells['column-status'])).toEqual([
      'Pending',
      'Pending',
    ]);
  });

  it('renames prompt parameters without breaking filter bindings', () => {
    store.addParameterForFilter('filter-status');
    const parameter = store
      .report()
      .query.parameters.find((currentParameter) => currentParameter.name === 'Status');

    store.updateParameterName(parameter?.id ?? '', '@VisitStatus');

    expect(
      store.report().query.filters.find((filter) => filter.id === 'filter-status')?.parameterName,
    ).toBe('VisitStatus');
  });

  it('clears filter prompt bindings when removing a parameter', () => {
    store.addParameterForFilter('filter-status');
    const parameter = store
      .report()
      .query.parameters.find((currentParameter) => currentParameter.name === 'Status');

    store.removeParameter(parameter?.id ?? '');

    expect(
      store.report().query.filters.find((filter) => filter.id === 'filter-status')?.parameterName,
    ).toBe('');
  });

  it('keeps prompted criteria scoped to the active subquery workspace', () => {
    store.addSubquery();
    store.selectTable('Diagnosis');
    store.addFilter('Diagnosis.DiagnosisCode');
    const filter = store.activeQuery().filters[0];

    store.updateFilterOperator(filter?.id ?? '', 'equals');
    store.updateFilterValue(filter?.id ?? '', 'I10');
    store.addParameterForFilter(filter?.id ?? '');
    const parameter = store.activeQuery().parameters[0];

    expect(store.report().query.filters.map((currentFilter) => currentFilter.id)).toEqual([
      'filter-status',
    ]);
    expect(
      store.report().query.parameters.map((currentParameter) => currentParameter.name),
    ).toEqual(['StartDate']);
    expect(store.activeQuery().filters[0]?.parameterName).toBe('DiagnosisCode');
    expect(store.activeFilteredSourceRows().map((row) => row['Diagnosis.DiagnosisCode'])).toEqual([
      'I10',
    ]);

    store.updateParameterDefaultValue(parameter?.id ?? '', 'F41.1');

    expect(store.activeFilteredSourceRows().map((row) => row['Diagnosis.DiagnosisCode'])).toEqual([
      'F41.1',
    ]);

    store.selectMainQuery();

    expect(store.activeQuery().filters.map((currentFilter) => currentFilter.id)).toEqual([
      'filter-status',
    ]);
    expect(store.activeQuery().parameters.map((currentParameter) => currentParameter.name)).toEqual(
      ['StartDate'],
    );
  });

  it('creates a subquery workspace and exposes it as a datasource in main', () => {
    store.addSubquery();
    const subquery = store.report().subqueries[0];

    expect(subquery).toBeTruthy();
    expect(store.activeQueryId()).toBe(subquery?.id);

    store.selectTable('Diagnosis');
    store.addColumn('Diagnosis.DiagnosisCode');

    expect(store.activeQuery().sourceTableIds).toEqual(['Diagnosis']);
    expect(store.activeQuery().columns.map((column) => column.alias)).toEqual(['DiagnosisCode']);

    store.selectMainQuery();
    const subqueryTableId = store.subqueryTableId(subquery?.id ?? '');

    expect(
      store
        .tableLookup()
        .get(subqueryTableId)
        ?.fields.map((field) => field.name),
    ).toEqual(['DiagnosisCode']);

    store.selectTable(subqueryTableId);

    expect(store.report().query.sourceTableIds).toContain(subqueryTableId);
  });

  it('keeps subquery source tables isolated from the main query', () => {
    store.addSubquery();
    const subquery = store.report().subqueries[0];

    store.selectTable('Diagnosis');

    expect(store.activeQuery().sourceTableIds).toEqual(['Diagnosis']);

    store.selectMainQuery();

    expect(store.report().query.sourceTableIds).not.toContain('Diagnosis');
    expect(store.report().query.sourceTableIds).not.toContain(
      store.subqueryTableId(subquery?.id ?? ''),
    );
  });

  it('updates subquery name and alias used by the derived datasource', () => {
    store.addSubquery();
    const subquery = store.report().subqueries[0];

    store.updateSubqueryName(subquery?.id ?? '', 'Billing Rollup');
    store.updateSubqueryAlias(subquery?.id ?? '', 'Billing Rollup 2026');

    const updatedSubquery = store.report().subqueries[0];
    const subqueryTable = store.tableLookup().get(store.subqueryTableId(updatedSubquery?.id ?? ''));

    expect(updatedSubquery?.name).toBe('Billing Rollup');
    expect(updatedSubquery?.alias).toBe('Billing_Rollup_2026');
    expect(subqueryTable?.label).toBe('Billing Rollup');
    expect(subqueryTable?.alias).toBe('Billing_Rollup_2026');
  });

  it('exposes only visible subquery columns as datasource fields', () => {
    store.addSubquery();
    const subquery = store.report().subqueries[0];

    store.selectTable('Diagnosis');
    store.addColumn('Diagnosis.DiagnosisCode');
    store.addColumn('Diagnosis.DiagnosisDescription');
    const descriptionColumn = store
      .activeQuery()
      .columns.find((column) => column.fieldId === 'Diagnosis.DiagnosisDescription');

    store.toggleColumnVisibility(descriptionColumn?.id ?? '', false);

    const subqueryTable = store.tableLookup().get(store.subqueryTableId(subquery?.id ?? ''));

    expect(subqueryTable?.fields.map((field) => field.name)).toEqual(['DiagnosisCode']);
  });

  it('builds active SQL and preview rows for the selected subquery workspace', () => {
    store.addSubquery();
    store.selectTable('Diagnosis');
    store.addColumn('Diagnosis.DiagnosisCode');

    const outputColumn = store.activePreviewColumns()[0];

    expect(store.activeQueryLabel()).toBe('Subquery 1');
    expect(outputColumn?.alias).toBe('DiagnosisCode');
    expect(store.activeSql()).toContain('FROM [dbo].[Diagnosis] AS [diagnosis]');
    expect(
      store
        .activePreviewRows()
        .slice(0, 2)
        .map((row) => row.cells[outputColumn?.id ?? '']),
    ).toEqual(['Z00.00', 'I10']);
  });

  it('reports active subquery validation when no visible output columns are selected', () => {
    store.addSubquery();
    store.selectTable('Diagnosis');
    store.addColumn('Diagnosis.DiagnosisCode');
    const outputColumn = store.activePreviewColumns()[0];

    store.toggleColumnVisibility(outputColumn?.id ?? '', false);

    expect(store.activeValidationIssues()).toContain(
      'Subquery 1: select at least one visible output column.',
    );
  });

  it('projects subquery datasource fields into the main mock preview rows', () => {
    store.addSubquery();
    const subquery = store.report().subqueries[0];

    store.selectTable('Diagnosis');
    store.addColumn('Diagnosis.DiagnosisCode');
    store.selectMainQuery();

    const subqueryTableId = store.subqueryTableId(subquery?.id ?? '');
    const subqueryFieldId = store.tableLookup().get(subqueryTableId)?.fields[0]?.id ?? '';

    store.selectTable(subqueryTableId);
    store.addColumn(subqueryFieldId);

    const projectedColumn = store
      .activePreviewColumns()
      .find((column) => column.fieldId === subqueryFieldId);

    expect(projectedColumn).toBeTruthy();
    expect(store.activeSql()).toContain('JOIN (');
    expect(store.activePreviewRows().map((row) => row.cells[projectedColumn?.id ?? ''])).toContain(
      'Z00.00',
    );
  });

  it('prevents indirect circular subquery datasource dependencies', () => {
    store.addSubquery();
    const firstSubquery = store.report().subqueries[0];

    store.selectTable('Diagnosis');
    store.addColumn('Diagnosis.DiagnosisCode');

    store.addSubquery();
    const secondSubquery = store.report().subqueries[1];
    const firstSubqueryTableId = store.subqueryTableId(firstSubquery?.id ?? '');
    const firstSubqueryFieldId = store.tableLookup().get(firstSubqueryTableId)?.fields[0]?.id ?? '';

    store.selectTable(firstSubqueryTableId);
    store.addColumn(firstSubqueryFieldId);

    const secondSubqueryTableId = store.subqueryTableId(secondSubquery?.id ?? '');
    const secondSubqueryFieldId =
      store.tableLookup().get(secondSubqueryTableId)?.fields[0]?.id ?? '';

    expect(store.activeQuery().sourceTableIds).toContain(firstSubqueryTableId);

    store.selectSubquery(firstSubquery?.id ?? '');

    expect(store.canUseTableAsSource(secondSubqueryTableId)).toBe(false);

    store.selectTable(secondSubqueryTableId);
    store.addColumn(secondSubqueryFieldId);

    expect(store.activeQuery().sourceTableIds).not.toContain(secondSubqueryTableId);
    expect(
      store.activeQuery().columns.some((column) => column.fieldId === secondSubqueryFieldId),
    ).toBe(false);
  });

  it('builds crosstabs from Main query output columns', () => {
    const matrix = store.crosstabMatrix();
    const harperRow = matrix.rows.find((row) => row.labels.includes('Dr. Harper'));

    expect(store.crosstabFields().map((field) => field.id)).toContain('column-provider');
    expect(store.crosstabFields().map((field) => field.id)).toContain('column-balance');
    expect(matrix.rowFields.map((field) => field.id)).toEqual(['column-provider']);
    expect(matrix.columnFields.map((field) => field.id)).toEqual(['column-status']);
    expect(matrix.valueDefinitions.map((value) => value.fieldId)).toEqual([
      'column-provider',
      'column-balance',
    ]);
    expect(harperRow?.cells['Completed::value-encounters']).toBe(2);
    expect(harperRow?.cells['Completed::value-balance']).toBe(54);
  });

  it('ignores raw datasource fields when configuring crosstabs', () => {
    const initialRowFieldIds = store.report().crosstab.rowFieldIds;
    const initialSourceTableIds = store.report().query.sourceTableIds;

    store.addCrosstabRow('Diagnosis.DiagnosisCode');
    store.addCrosstabValue('Diagnosis.DiagnosisCode', 'count');

    expect(store.report().crosstab.rowFieldIds).toEqual(initialRowFieldIds);
    expect(store.report().crosstab.values.map((value) => value.fieldId)).not.toContain(
      'Diagnosis.DiagnosisCode',
    );
    expect(store.report().query.sourceTableIds).toEqual(initialSourceTableIds);
  });

  it('removes crosstab fields when their Main query output columns are removed', () => {
    store.removeSourceTable('FinancialLedger');

    expect(store.crosstabDefinition().values.map((value) => value.fieldId)).not.toContain(
      'column-balance',
    );
    expect(store.report().crosstab.values.map((value) => value.fieldId)).not.toContain(
      'column-balance',
    );
  });

  it('prevents duplicate crosstab values for the same field and aggregation', () => {
    const initialValues = store.report().crosstab.values;

    store.addCrosstabValue('column-balance', 'sum');

    expect(store.report().crosstab.values).toEqual(initialValues);

    store.addCrosstabValue('column-balance', 'avg');

    expect(store.crosstabDefinition().values.map((value) => value.aggregation)).toContain('avg');
  });

  it('reorders crosstab row, column, and value fields', () => {
    store.addCrosstabRow('column-facility');
    store.addCrosstabColumn('column-visit-type');

    store.moveCrosstabRow('column-facility', -1);
    store.moveCrosstabColumn('column-visit-type', -1);
    store.moveCrosstabValue('value-balance', -1);

    expect(store.crosstabDefinition().rowFieldIds).toEqual(['column-facility', 'column-provider']);
    expect(store.crosstabDefinition().columnFieldIds).toEqual([
      'column-visit-type',
      'column-status',
    ]);
    expect(store.crosstabDefinition().values.map((value) => value.id)).toEqual([
      'value-balance',
      'value-encounters',
    ]);
  });

  it('reports crosstab config issues for incomplete configuration', () => {
    store.removeCrosstabRow('column-provider');
    store.removeCrosstabColumn('column-status');
    store.removeCrosstabValue('value-encounters');
    store.removeCrosstabValue('value-balance');

    expect(store.crosstabConfigIssues()).toEqual([
      'Add at least one row field.',
      'Add at least one column field.',
      'Add at least one value.',
    ]);
  });

  it('builds the crosstab matrix from valid values when stale values are present', () => {
    TestBed.resetTestingModule();
    const invalidReport: ReportDefinition = {
      ...cloneValue(MOCK_REPORT),
      crosstab: {
        ...MOCK_REPORT.crosstab,
        values: MOCK_REPORT.crosstab.values.map((value) =>
          value.id === 'value-encounters'
            ? {
                ...value,
                fieldId: 'missing-output-column',
              }
            : value,
        ),
      },
    };
    const api: QueryEditorApi = {
      loadReport: () =>
        of({
          metadata: cloneValue(DATA_SOURCE_GROUPS),
          report: invalidReport,
          rows: cloneValue(MOCK_ROWS),
        }),
      saveReport: (report: ReportDefinition) =>
        of({
          report: cloneValue(report),
          savedAt: '2026-07-01T00:00:00.000Z',
          message: 'Saved',
        }),
    };

    TestBed.configureTestingModule({
      providers: [{ provide: QUERY_EDITOR_API, useValue: api }],
    });
    const invalidStore = TestBed.inject(QueryEditorStore);

    expect(invalidStore.crosstabConfigIssues()).toContain(
      'Encounters is not available in Main query output.',
    );
    expect(invalidStore.crosstabMatrix().valueDefinitions.map((value) => value.id)).toEqual([
      'value-balance',
    ]);
    expect(invalidStore.crosstabMatrix().rows.length).toBeGreaterThan(0);
  });

  it('sorts preview rows by query column sorting', () => {
    store.updateColumnSort('column-check-date', 'none');
    store.updateColumnSort('column-balance', 'desc');

    expect(store.previewRows().map((row) => row.cells['column-balance'])).toEqual([
      140, 85, 68, 42, 24, 18, 12, 0,
    ]);
  });

  it('adds a new condition to an existing join instead of creating another join', () => {
    const initialJoinCount = store.report().query.joins.length;
    const joinId = store.addJoinOrCondition('Encounter.Minutes', 'Patient.Gender');
    const join = store.report().query.joins.find((currentJoin) => currentJoin.id === joinId);

    expect(joinId).toBe('join-encounter-patient');
    expect(store.report().query.joins.length).toBe(initialJoinCount);
    expect(join?.conditions.length).toBe(2);
    expect(join?.conditions[1]).toEqual({
      id: expect.any(String),
      fromFieldId: 'Encounter.Minutes',
      operator: 'equals',
      toFieldId: 'Patient.Gender',
    });
  });

  it('keeps condition orientation aligned with the existing join', () => {
    store.addJoinOrCondition('Patient.Gender', 'Encounter.Minutes');
    const join = store
      .report()
      .query.joins.find((currentJoin) => currentJoin.id === 'join-encounter-patient');

    expect(join?.conditions[1]).toEqual({
      id: expect.any(String),
      fromFieldId: 'Encounter.Minutes',
      operator: 'equals',
      toFieldId: 'Patient.Gender',
    });
  });

  it('rejects duplicate and same-table join drops', () => {
    expect(store.assessJoinDrop('Encounter.PatientId', 'Patient.PatientId')).toEqual({
      mode: 'invalid',
      canDrop: false,
      message: 'This join condition already exists.',
    });
    expect(store.addJoinOrCondition('Encounter.PatientId', 'Patient.PatientId')).toBeNull();
    expect(store.assessJoinDrop('Encounter.PatientId', 'Encounter.EncounterId')).toEqual({
      mode: 'invalid',
      canDrop: false,
      message: 'Fields from the same table cannot be joined.',
    });
    expect(store.addJoinOrCondition('Encounter.PatientId', 'Encounter.EncounterId')).toBeNull();
  });
});

function cloneValue<T>(value: T): T {
  return structuredClone(value);
}
