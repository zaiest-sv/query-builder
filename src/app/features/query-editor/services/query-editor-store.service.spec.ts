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
