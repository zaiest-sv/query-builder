import { DATA_SOURCE_GROUPS, MOCK_REPORT } from '../data/mock-report-data';
import { DataSourceField, DataSourceTable, QueryJoin } from '../models/report-definition.model';
import {
  areJoinConditionsEqual,
  findConflictingJoinPairIds,
  findDuplicateJoinConditionIds,
  findDuplicateJoinPairIds,
  getJoinTablePair,
  QueryJoinGraphService,
  joinTouchesTable,
} from './query-join-graph.service';

describe('QueryJoinGraphService', () => {
  let service: QueryJoinGraphService;
  let tableLookup: ReadonlyMap<string, DataSourceTable>;
  let fieldLookup: ReadonlyMap<string, DataSourceField>;
  let joins: readonly QueryJoin[];

  beforeEach(() => {
    service = new QueryJoinGraphService();
    const tables = DATA_SOURCE_GROUPS.flatMap((group) => group.tables);
    tableLookup = new Map(tables.map((table) => [table.id, table] as const));
    fieldLookup = new Map(
      tables.flatMap((table) => table.fields).map((field) => [field.id, field] as const),
    );
    joins = MOCK_REPORT.query.joins;
  });

  it('assesses create, condition, duplicate, and same-table drops', () => {
    expect(
      service.assessJoinDrop('Encounter.EncounterId', 'Diagnosis.EncounterId', joins, fieldLookup),
    ).toEqual({
      mode: 'create',
      canDrop: true,
      message: 'Create join.',
    });
    expect(
      service.assessJoinDrop('Encounter.Minutes', 'Patient.Gender', joins, fieldLookup),
    ).toEqual({
      mode: 'condition',
      canDrop: true,
      message: 'Add condition to existing join.',
      targetJoinId: 'join-encounter-patient',
    });
    expect(
      service.assessJoinDrop('Patient.PatientId', 'Encounter.PatientId', joins, fieldLookup),
    ).toEqual({
      mode: 'invalid',
      canDrop: false,
      message: 'This join condition already exists.',
    });
    expect(
      service.assessJoinDrop('Encounter.PatientId', 'Encounter.EncounterId', joins, fieldLookup),
    ).toEqual({
      mode: 'invalid',
      canDrop: false,
      message: 'Fields from the same table cannot be joined.',
    });
  });

  it('orients new conditions to match the existing join direction', () => {
    const join = joins.find((currentJoin) => currentJoin.id === 'join-encounter-patient');

    expect(join).toBeTruthy();
    expect(
      service.orientJoinConditionForJoin(
        join as QueryJoin,
        'Patient.Gender',
        'Encounter.Minutes',
        fieldLookup,
      ),
    ).toEqual({
      fromFieldId: 'Encounter.Minutes',
      operator: 'equals',
      toFieldId: 'Patient.Gender',
    });
  });

  it('suggests unused field pairs for an existing join', () => {
    const join = joins.find((currentJoin) => currentJoin.id === 'join-encounter-patient');
    const candidate = join
      ? service.findSuggestedJoinCondition(join, tableLookup, fieldLookup)
      : null;

    expect(candidate).toBeTruthy();
    expect(candidate).not.toEqual({
      fromFieldId: 'Encounter.PatientId',
      operator: 'equals',
      toFieldId: 'Patient.PatientId',
    });
  });

  it('detects duplicate condition ids and table usage', () => {
    const duplicateIds = findDuplicateJoinConditionIds([
      {
        id: 'condition-1',
        fromFieldId: 'Encounter.PatientId',
        operator: 'equals',
        toFieldId: 'Patient.PatientId',
      },
      {
        id: 'condition-2',
        fromFieldId: 'Encounter.PatientId',
        operator: 'equals',
        toFieldId: 'Patient.PatientId',
      },
    ]);

    expect(duplicateIds.has('condition-1')).toBe(true);
    expect(duplicateIds.has('condition-2')).toBe(true);
    expect(joinTouchesTable(joins[0] as QueryJoin, 'Patient', fieldLookup)).toBe(true);
    expect(joinTouchesTable(joins[0] as QueryJoin, 'Diagnosis', fieldLookup)).toBe(false);
  });

  it('detects duplicate and conflicting table-pair joins', () => {
    const duplicatePairJoins: readonly QueryJoin[] = [
      ...(joins as QueryJoin[]),
      {
        id: 'join-encounter-patient-extra',
        type: 'left',
        conditions: [
          {
            id: 'join-encounter-patient-extra-condition',
            fromFieldId: 'Encounter.Minutes',
            operator: 'equals',
            toFieldId: 'Patient.Gender',
          },
        ],
      },
      {
        id: 'join-encounter-patient-conflict',
        type: 'inner',
        conditions: [
          {
            id: 'join-encounter-patient-conflict-condition',
            fromFieldId: 'Encounter.Provider',
            operator: 'equals',
            toFieldId: 'Patient.InsuranceType',
          },
        ],
      },
    ];

    expect(getJoinTablePair(joins[0] as QueryJoin, fieldLookup)).toEqual({
      key: 'Encounter::Patient',
      firstTableId: 'Encounter',
      secondTableId: 'Patient',
    });
    expect(Array.from(findDuplicateJoinPairIds(duplicatePairJoins, fieldLookup))).toEqual([
      'join-encounter-patient',
      'join-encounter-patient-extra',
      'join-encounter-patient-conflict',
    ]);
    expect(Array.from(findConflictingJoinPairIds(duplicatePairJoins, fieldLookup))).toEqual([
      'join-encounter-patient',
      'join-encounter-patient-extra',
      'join-encounter-patient-conflict',
    ]);
  });

  it('compares join condition values without object identity', () => {
    expect(
      areJoinConditionsEqual(
        {
          id: 'condition-1',
          fromFieldId: 'Encounter.PatientId',
          operator: 'equals',
          toFieldId: 'Patient.PatientId',
        },
        {
          id: 'condition-1',
          fromFieldId: 'Encounter.PatientId',
          operator: 'equals',
          toFieldId: 'Patient.PatientId',
        },
      ),
    ).toBe(true);
  });
});
