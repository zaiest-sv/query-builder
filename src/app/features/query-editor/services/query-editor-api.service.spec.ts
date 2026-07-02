import { firstValueFrom } from 'rxjs';
import { MOCK_REPORT } from '../data/mock-report-data';
import { ReportDefinition } from '../models/report-definition.model';
import { MockQueryEditorApiService } from './query-editor-api.service';

const storageKey = 'query-builder.mock-report';

describe('MockQueryEditorApiService persistence normalization', () => {
  beforeEach(() => {
    globalThis.localStorage?.clear();
  });

  afterEach(() => {
    globalThis.localStorage?.clear();
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

    const service = new MockQueryEditorApiService();
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

    const service = new MockQueryEditorApiService();
    const { report } = await firstValueFrom(service.loadReport(MOCK_REPORT.id));

    expect(report.id).toBe(MOCK_REPORT.id);
    expect(report.query.columns.map((column) => column.id)).toEqual(
      MOCK_REPORT.query.columns.map((column) => column.id),
    );
    expect(globalThis.localStorage?.getItem(storageKey)).toBeNull();
  });

  it('ignores stored reports from another mock report id', async () => {
    globalThis.localStorage?.setItem(
      storageKey,
      JSON.stringify({
        ...cloneValue(MOCK_REPORT),
        id: 'other-report',
      }),
    );

    const service = new MockQueryEditorApiService();
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

    const service = new MockQueryEditorApiService();

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
});

function cloneValue<T>(value: T): T {
  return structuredClone(value);
}
