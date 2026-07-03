import { TestBed } from '@angular/core/testing';
import { firstValueFrom } from 'rxjs';
import { MOCK_REPORT } from '../data/mock-report-data';
import { ReportDefinition } from '../models/report-definition.model';
import { MockQueryEditorApiService } from './query-editor-api.service';

const storageKey = 'query-builder.mock-report';

describe('MockQueryEditorApiService persistence normalization', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({});
    globalThis.localStorage?.clear();
  });

  afterEach(() => {
    globalThis.localStorage?.clear();
    TestBed.resetTestingModule();
  });

  it('migrates legacy raw stored reports and removes stale references', async () => {
    const staleReport: ReportDefinition = {
      ...cloneValue(MOCK_REPORT),
      query: {
        ...cloneValue(MOCK_REPORT.query),
        sourceTableIds: [...MOCK_REPORT.query.sourceTableIds, 'RemovedTable'],
        columns: [
          ...MOCK_REPORT.query.columns,
          {
            id: 'column-removed',
            fieldId: 'RemovedTable.RemovedField',
            expression: 'RemovedTable.RemovedField',
            alias: 'RemovedField',
            visible: true,
            sortDirection: 'none',
          },
        ],
        filters: [
          ...MOCK_REPORT.query.filters,
          {
            id: 'filter-removed',
            fieldId: 'RemovedTable.RemovedField',
            operator: 'equals',
            value: 'x',
            parameterName: '@Missing',
          },
        ],
        joins: [
          {
            id: 'legacy-join',
            type: 'left',
            fromFieldId: 'Encounter.PatientId',
            toFieldId: 'Patient.PatientId',
          } as unknown as ReportDefinition['query']['joins'][number],
          {
            id: 'stale-join',
            type: 'left',
            conditions: [
              {
                id: 'stale-join-condition',
                fromFieldId: 'RemovedTable.RemovedField',
                operator: 'equals',
                toFieldId: 'Patient.PatientId',
              },
            ],
          },
        ],
      },
      crosstab: {
        ...MOCK_REPORT.crosstab,
        values: [
          ...MOCK_REPORT.crosstab.values,
          {
            id: 'value-removed',
            fieldId: 'RemovedTable.RemovedField',
            label: 'Removed',
            aggregation: 'count',
          },
        ],
      },
    };

    globalThis.localStorage?.setItem(storageKey, JSON.stringify(staleReport));

    const service = TestBed.inject(MockQueryEditorApiService);
    const { report } = await firstValueFrom(service.loadReport(MOCK_REPORT.id));
    const storedReport = JSON.parse(globalThis.localStorage?.getItem(storageKey) ?? '{}') as {
      readonly schemaVersion?: number;
      readonly report?: ReportDefinition;
    };

    expect(report.query.sourceTableIds).not.toContain('RemovedTable');
    expect(report.query.columns.map((column) => column.id)).not.toContain('column-removed');
    expect(report.query.filters.map((filter) => filter.id)).not.toContain('filter-removed');
    expect(report.query.joins).toEqual([
      {
        id: 'legacy-join',
        type: 'left',
        conditions: [
          {
            id: 'legacy-join-condition-1',
            fromFieldId: 'Encounter.PatientId',
            operator: 'equals',
            toFieldId: 'Patient.PatientId',
          },
        ],
      },
    ]);
    expect(report.crosstab.values.map((value) => value.id)).not.toContain('value-removed');
    expect(storedReport.schemaVersion).toBe(2);
    expect(storedReport.report?.query.columns.map((column) => column.id)).not.toContain(
      'column-removed',
    );
  });

  it('falls back to the baseline report and clears broken storage', async () => {
    globalThis.localStorage?.setItem(storageKey, '{not-json');

    const service = TestBed.inject(MockQueryEditorApiService);
    const { report } = await firstValueFrom(service.loadReport(MOCK_REPORT.id));

    expect(report.id).toBe(MOCK_REPORT.id);
    expect(report.query.columns.map((column) => column.id)).toEqual(
      MOCK_REPORT.query.columns.map((column) => column.id),
    );
    expect(globalThis.localStorage?.getItem(storageKey)).toBeNull();
  });

  it('merges persisted same-type joins for the same datasource pair', async () => {
    const report: ReportDefinition = {
      ...cloneValue(MOCK_REPORT),
      query: {
        ...cloneValue(MOCK_REPORT.query),
        joins: [
          ...cloneValue(MOCK_REPORT.query.joins),
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
        ],
      },
    };

    globalThis.localStorage?.setItem(storageKey, JSON.stringify(report));

    const service = TestBed.inject(MockQueryEditorApiService);
    const { report: normalizedReport } = await firstValueFrom(service.loadReport(MOCK_REPORT.id));
    const encounterPatientJoin = normalizedReport.query.joins.find(
      (join) => join.id === 'join-encounter-patient',
    );

    expect(normalizedReport.query.joins.map((join) => join.id)).not.toContain(
      'join-encounter-patient-extra',
    );
    expect(encounterPatientJoin?.conditions.map((condition) => condition.id)).toEqual([
      'join-encounter-patient-condition-1',
      'join-encounter-patient-extra-condition',
    ]);
  });

  it('normalizes prompt parameter kind, source field, and lookup options', async () => {
    const report: ReportDefinition = {
      ...cloneValue(MOCK_REPORT),
      query: {
        ...cloneValue(MOCK_REPORT.query),
        parameters: [
          {
            id: 'param-static-with-source',
            name: '@Visit Status',
            label: 'Visit Status',
            type: 'string',
            required: false,
            defaultValue: 'Completed',
            kind: 'static',
            sourceFieldId: 'Encounter.Status',
            lookup: {
              enabled: true,
              multiple: false,
              options: [' Completed ', 'Pending', 'Completed', ' '],
            },
          },
          {
            id: 'param-provider',
            name: '@Provider Filter',
            label: 'Provider',
            type: 'string',
            required: true,
            defaultValue: 'Dr. Harper',
            kind: 'dynamic',
            sourceFieldId: 'Encounter.Provider',
            lookup: {
              enabled: true,
              multiple: true,
              options: ['Dr. Harper', ' Dr. Nguyen ', 'Dr. Harper'],
            },
          },
        ],
      },
    };

    globalThis.localStorage?.setItem(storageKey, JSON.stringify(report));

    const service = TestBed.inject(MockQueryEditorApiService);
    const { report: normalizedReport } = await firstValueFrom(service.loadReport(MOCK_REPORT.id));
    const staticParameter = normalizedReport.query.parameters.find(
      (parameter) => parameter.id === 'param-static-with-source',
    );
    const dynamicParameter = normalizedReport.query.parameters.find(
      (parameter) => parameter.id === 'param-provider',
    );

    expect(staticParameter).toEqual({
      id: 'param-static-with-source',
      name: 'Visit_Status',
      label: 'Visit Status',
      type: 'string',
      required: false,
      defaultValue: 'Completed',
      kind: 'static',
      lookup: {
        enabled: true,
        multiple: false,
        options: ['Completed', 'Pending'],
      },
    });
    expect(dynamicParameter).toEqual({
      id: 'param-provider',
      name: 'Provider_Filter',
      label: 'Provider',
      type: 'string',
      required: true,
      defaultValue: 'Dr. Harper',
      kind: 'dynamic',
      sourceFieldId: 'Encounter.Provider',
      lookup: {
        enabled: true,
        multiple: true,
        options: ['Dr. Harper', 'Dr. Nguyen'],
      },
    });
  });

  it('ignores stored reports from another mock report id', async () => {
    globalThis.localStorage?.setItem(
      storageKey,
      JSON.stringify({
        ...cloneValue(MOCK_REPORT),
        id: 'other-report',
      }),
    );

    const service = TestBed.inject(MockQueryEditorApiService);
    const { report } = await firstValueFrom(service.loadReport(MOCK_REPORT.id));

    expect(report.id).toBe(MOCK_REPORT.id);
    expect(globalThis.localStorage?.getItem(storageKey)).toBeNull();
  });

  it('normalizes saved reports before writing the storage envelope', async () => {
    const report: ReportDefinition = {
      ...cloneValue(MOCK_REPORT),
      crosstab: {
        ...MOCK_REPORT.crosstab,
        values: [
          ...MOCK_REPORT.crosstab.values,
          {
            id: 'value-stale',
            fieldId: 'missing-output-column',
            label: 'Stale',
            aggregation: 'count',
          },
        ],
      },
    };

    const service = TestBed.inject(MockQueryEditorApiService);

    await firstValueFrom(service.saveReport(report));

    const storedReport = JSON.parse(globalThis.localStorage?.getItem(storageKey) ?? '{}') as {
      readonly schemaVersion?: number;
      readonly report?: ReportDefinition;
    };

    expect(storedReport.schemaVersion).toBe(2);
    expect(storedReport.report?.crosstab.values.map((value) => value.id)).not.toContain(
      'value-stale',
    );
  });

  it('returns server-style validation and preview responses for mock data', async () => {
    const service = TestBed.inject(MockQueryEditorApiService);
    const validation = await firstValueFrom(service.validateReport(MOCK_REPORT));
    const preview = await firstValueFrom(
      service.previewReport({
        report: MOCK_REPORT,
        queryId: 'main',
        limit: 2,
        parameterValues: {},
      }),
    );

    expect(validation.status).toBe('valid');
    expect(validation.issues).toEqual([]);
    expect(preview.status).toBe('ready');
    expect(preview.rows.length).toBe(2);
    expect(preview.columns.map((column) => column.id)).toEqual(
      MOCK_REPORT.query.columns.filter((column) => column.visible).map((column) => column.id),
    );
    expect(preview.generatedSql).toContain('SELECT');
  });
});

function cloneValue<T>(value: T): T {
  return structuredClone(value);
}
