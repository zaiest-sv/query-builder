import { DATA_SOURCE_GROUPS, MOCK_REPORT } from '../data/mock-report-data';
import { DataSourceField, DataSourceTable, ReportDefinition } from '../models/report-definition.model';
import { QuerySqlBuilderService } from './query-sql-builder.service';

describe('QuerySqlBuilderService', () => {
  const tables = DATA_SOURCE_GROUPS.flatMap((group) => group.tables);
  const tableLookup = new Map<string, DataSourceTable>(tables.map((table) => [table.id, table]));
  const fieldLookup = new Map<string, DataSourceField>(
    tables.flatMap((table) => table.fields).map((field) => [field.id, field]),
  );
  const service = new QuerySqlBuilderService();

  it('builds SQL using table aliases and quoted identifiers', () => {
    const sql = service.build(MOCK_REPORT, tableLookup, fieldLookup);

    expect(sql).toContain('FROM [dbo].[Encounter] AS [encounter]');
    expect(sql).toContain(
      'LEFT JOIN [dbo].[Patient] AS [patient] ON [encounter].[PatientId] = [patient].[PatientId]',
    );
    expect(sql).toContain(
      'LEFT JOIN [dbo].[FinancialLedger] AS [ledger] ON [encounter].[EncounterId] = [ledger].[EncounterId]',
    );
    expect(sql).toContain('[encounter].[CheckDate] AS [CheckDate]');
    expect(sql).toContain("[encounter].[Status] <> 'Cancelled'");
    expect(sql).toContain('ORDER BY [CheckDate] DESC');
    expect(sql).not.toContain('Encounter.CheckDate AS');
  });

  it('formats numeric filter values without string quotes', () => {
    const report: ReportDefinition = {
      ...MOCK_REPORT,
      query: {
        ...MOCK_REPORT.query,
        filters: [
          {
            id: 'filter-balance',
            fieldId: 'FinancialLedger.Balance',
            operator: 'greaterThan',
            value: '10',
            parameterName: '',
          },
        ],
      },
    };
    const sql = service.build(report, tableLookup, fieldLookup);

    expect(sql).toContain('[ledger].[Balance] > 10');
  });

  it('builds SQL from column criteria, OR criteria, and grouping flags', () => {
    const report: ReportDefinition = {
      ...MOCK_REPORT,
      query: {
        ...MOCK_REPORT.query,
        columns: MOCK_REPORT.query.columns.map((column) =>
          column.id === 'column-provider'
            ? {
                ...column,
                groupBy: true,
                criteria: 'Dr. Harper',
                orCriteria: ['Dr. Nguyen'],
              }
            : column,
        ),
      },
    };
    const sql = service.build(report, tableLookup, fieldLookup);

    expect(sql).toContain(
      "([encounter].[Provider] = 'Dr. Harper' OR [encounter].[Provider] = 'Dr. Nguyen')",
    );
    expect(sql).toContain('GROUP BY [encounter].[Provider]');
  });

  it('combines multiple field joins between the same tables', () => {
    const report: ReportDefinition = {
      ...MOCK_REPORT,
      query: {
        ...MOCK_REPORT.query,
        joins: MOCK_REPORT.query.joins.map((join) =>
          join.id === 'join-encounter-patient'
            ? {
                ...join,
                conditions: [
                  ...join.conditions,
                  {
                    id: 'join-extra-patient-condition',
                    fromFieldId: 'Encounter.Minutes',
                    operator: 'equals',
                    toFieldId: 'Patient.Gender',
                  },
                ],
              }
            : join,
        ),
      },
    };
    const sql = service.build(report, tableLookup, fieldLookup);

    expect(sql).toContain(
      'LEFT JOIN [dbo].[Patient] AS [patient] ON [encounter].[PatientId] = [patient].[PatientId] AND [encounter].[Minutes] = [patient].[Gender]',
    );
  });

  it('uses configured operators in join conditions', () => {
    const report: ReportDefinition = {
      ...MOCK_REPORT,
      query: {
        ...MOCK_REPORT.query,
        joins: MOCK_REPORT.query.joins.map((join) =>
          join.id === 'join-encounter-ledger'
            ? {
                ...join,
                conditions: join.conditions.map((condition) => ({
                  ...condition,
                  operator: 'greaterThanOrEquals',
                })),
              }
            : join,
        ),
      },
    };
    const sql = service.build(report, tableLookup, fieldLookup);

    expect(sql).toContain(
      'LEFT JOIN [dbo].[FinancialLedger] AS [ledger] ON [encounter].[EncounterId] >= [ledger].[EncounterId]',
    );
  });
});
