import { DATA_SOURCE_GROUPS, MOCK_REPORT } from '../data/mock-report-data';
import {
  DataSourceField,
  DataSourceTable,
  ReportDefinition,
} from '../models/report-definition.model';
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

  it('uses custom column expressions instead of forcing field references', () => {
    const report: ReportDefinition = {
      ...MOCK_REPORT,
      query: {
        ...MOCK_REPORT.query,
        columns: MOCK_REPORT.query.columns.map((column) =>
          column.id === 'column-provider'
            ? {
                ...column,
                expression: 'UPPER([encounter].[Provider])',
                alias: 'ProviderUpper',
              }
            : column,
        ),
      },
    };
    const sql = service.build(report, tableLookup, fieldLookup);

    expect(sql).toContain('UPPER([encounter].[Provider]) AS [ProviderUpper]');
    expect(sql).not.toContain('[encounter].[Provider] AS [ProviderUpper]');
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

  it('combines duplicate same-type table-pair join objects into one SQL join', () => {
    const report: ReportDefinition = {
      ...MOCK_REPORT,
      query: {
        ...MOCK_REPORT.query,
        sourceTableIds: ['Encounter', 'Patient'],
        joins: [
          {
            id: 'join-encounter-patient',
            type: 'left',
            conditions: [
              {
                id: 'join-encounter-patient-condition-1',
                fromFieldId: 'Encounter.PatientId',
                operator: 'equals',
                toFieldId: 'Patient.PatientId',
              },
            ],
          },
          {
            id: 'join-encounter-patient-extra',
            type: 'left',
            conditions: [
              {
                id: 'join-encounter-patient-condition-2',
                fromFieldId: 'Encounter.Minutes',
                operator: 'equals',
                toFieldId: 'Patient.Gender',
              },
            ],
          },
        ],
      },
    };
    const sql = service.build(report, tableLookup, fieldLookup);

    expect(sql.match(/JOIN \[dbo\]\.\[Patient\]/g)?.length).toBe(1);
    expect(sql).toContain(
      'LEFT JOIN [dbo].[Patient] AS [patient] ON [encounter].[PatientId] = [patient].[PatientId] AND [encounter].[Minutes] = [patient].[Gender]',
    );
  });

  it('does not silently merge conflicting table-pair join types', () => {
    const report: ReportDefinition = {
      ...MOCK_REPORT,
      query: {
        ...MOCK_REPORT.query,
        sourceTableIds: ['Encounter', 'Patient'],
        joins: [
          {
            id: 'join-encounter-patient-left',
            type: 'left',
            conditions: [
              {
                id: 'join-encounter-patient-left-condition',
                fromFieldId: 'Encounter.PatientId',
                operator: 'equals',
                toFieldId: 'Patient.PatientId',
              },
            ],
          },
          {
            id: 'join-encounter-patient-inner',
            type: 'inner',
            conditions: [
              {
                id: 'join-encounter-patient-inner-condition',
                fromFieldId: 'Encounter.Minutes',
                operator: 'equals',
                toFieldId: 'Patient.Gender',
              },
            ],
          },
        ],
      },
    };
    const sql = service.build(report, tableLookup, fieldLookup);

    expect(sql).toContain(
      '/* Invalid join: conflicting join types between the same datasource pair (join-encounter-patient-left, join-encounter-patient-inner) */',
    );
    expect(sql).toContain('CROSS JOIN [dbo].[Patient] AS [patient]');
    expect(sql).not.toContain('LEFT JOIN [dbo].[Patient] AS [patient]');
    expect(sql).not.toContain('INNER JOIN [dbo].[Patient] AS [patient]');
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

  it('builds subquery datasources as derived tables', () => {
    const subqueryTable: DataSourceTable = {
      id: 'subquery:subquery-status',
      schema: 'subquery',
      name: 'Status Subquery',
      alias: 'status_sq',
      label: 'Status Subquery',
      sourceType: 'subquery',
      subqueryId: 'subquery-status',
      fields: [
        {
          id: 'subquery:subquery-status.Status',
          tableId: 'subquery:subquery-status',
          name: 'Status',
          label: 'Status',
          expression: 'status_sq.Status',
          type: 'string',
          nullable: false,
          aggregations: ['count'],
        },
      ],
    };
    const report: ReportDefinition = {
      ...MOCK_REPORT,
      query: {
        ...MOCK_REPORT.query,
        sourceTableIds: ['subquery:subquery-status'],
        columns: [
          {
            id: 'column-subquery-status',
            fieldId: 'subquery:subquery-status.Status',
            expression: 'status_sq.Status',
            alias: 'Status',
            visible: true,
            sortDirection: 'none',
          },
        ],
        filters: [],
        joins: [],
      },
      subqueries: [
        {
          id: 'subquery-status',
          name: 'Status Subquery',
          alias: 'status_sq',
          query: {
            ...MOCK_REPORT.query,
            sourceTableIds: ['Encounter'],
            columns: [
              {
                id: 'column-status-output',
                fieldId: 'Encounter.Status',
                expression: 'Encounter.Status',
                alias: 'Status',
                visible: true,
                sortDirection: 'none',
              },
            ],
            filters: [],
            joins: [],
          },
        },
      ],
    };
    const subqueryTableLookup = new Map(tableLookup);
    const subqueryFieldLookup = new Map(fieldLookup);

    subqueryTableLookup.set(subqueryTable.id, subqueryTable);
    subqueryFieldLookup.set(subqueryTable.fields[0].id, subqueryTable.fields[0]);

    const sql = service.build(report, subqueryTableLookup, subqueryFieldLookup);

    expect(sql).toContain('FROM (');
    expect(sql).toContain(
      '  SELECT\n    [encounter].[Status] AS [Status]\n  FROM [dbo].[Encounter] AS [encounter]',
    );
    expect(sql).toContain(') AS [status_sq]');
    expect(sql).toContain('[status_sq].[Status] AS [Status]');
  });

  it('guards SQL generation for circular subquery dependencies', () => {
    const firstSubqueryTable: DataSourceTable = {
      id: 'subquery:first',
      schema: 'subquery',
      name: 'First',
      alias: 'first_sq',
      label: 'First',
      sourceType: 'subquery',
      subqueryId: 'first',
      fields: [
        {
          id: 'subquery:first.Code',
          tableId: 'subquery:first',
          name: 'Code',
          label: 'Code',
          expression: 'first_sq.Code',
          type: 'string',
          nullable: false,
          aggregations: ['count'],
        },
      ],
    };
    const secondSubqueryTable: DataSourceTable = {
      ...firstSubqueryTable,
      id: 'subquery:second',
      name: 'Second',
      alias: 'second_sq',
      label: 'Second',
      subqueryId: 'second',
      fields: [
        {
          ...firstSubqueryTable.fields[0],
          id: 'subquery:second.Code',
          tableId: 'subquery:second',
          expression: 'second_sq.Code',
        },
      ],
    };
    const report: ReportDefinition = {
      ...MOCK_REPORT,
      query: {
        ...MOCK_REPORT.query,
        sourceTableIds: ['subquery:first'],
        columns: [
          {
            id: 'column-first-code',
            fieldId: 'subquery:first.Code',
            expression: 'first_sq.Code',
            alias: 'Code',
            visible: true,
            sortDirection: 'none',
          },
        ],
        filters: [],
        joins: [],
      },
      subqueries: [
        {
          id: 'first',
          name: 'First',
          alias: 'first_sq',
          query: {
            ...MOCK_REPORT.query,
            sourceTableIds: ['subquery:second'],
            columns: [
              {
                id: 'column-second-code',
                fieldId: 'subquery:second.Code',
                expression: 'second_sq.Code',
                alias: 'Code',
                visible: true,
                sortDirection: 'none',
              },
            ],
            filters: [],
            joins: [],
          },
        },
        {
          id: 'second',
          name: 'Second',
          alias: 'second_sq',
          query: {
            ...MOCK_REPORT.query,
            sourceTableIds: ['subquery:first'],
            columns: [
              {
                id: 'column-first-code-output',
                fieldId: 'subquery:first.Code',
                expression: 'first_sq.Code',
                alias: 'Code',
                visible: true,
                sortDirection: 'none',
              },
            ],
            filters: [],
            joins: [],
          },
        },
      ],
    };
    const subqueryTableLookup = new Map(tableLookup);
    const subqueryFieldLookup = new Map(fieldLookup);

    subqueryTableLookup.set(firstSubqueryTable.id, firstSubqueryTable);
    subqueryTableLookup.set(secondSubqueryTable.id, secondSubqueryTable);
    subqueryFieldLookup.set(firstSubqueryTable.fields[0].id, firstSubqueryTable.fields[0]);
    subqueryFieldLookup.set(secondSubqueryTable.fields[0].id, secondSubqueryTable.fields[0]);

    const sql = service.build(report, subqueryTableLookup, subqueryFieldLookup);

    expect(sql).toContain('CircularDependency');
    expect(sql).toContain(') AS [first_sq]');
    expect(sql).toContain(') AS [second_sq]');
  });
});
