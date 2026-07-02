import { MOCK_REPORT, MOCK_ROWS } from '../data/mock-report-data';
import { DataRecord, DataSourceField } from '../models/report-definition.model';
import { CrosstabEngineService } from './crosstab-engine.service';

describe('CrosstabEngineService', () => {
  const fields: readonly DataSourceField[] = [
    {
      id: 'column-provider',
      tableId: 'query-output',
      name: 'Provider',
      label: 'Provider',
      expression: 'Encounter.Provider',
      type: 'string',
      nullable: false,
      aggregations: ['count'],
    },
    {
      id: 'column-status',
      tableId: 'query-output',
      name: 'Status',
      label: 'Status',
      expression: 'Encounter.Status',
      type: 'string',
      nullable: false,
      aggregations: ['count'],
    },
    {
      id: 'column-balance',
      tableId: 'query-output',
      name: 'Balance',
      label: 'Balance',
      expression: 'FinancialLedger.Balance',
      type: 'number',
      nullable: false,
      aggregations: ['count', 'sum', 'avg', 'min', 'max'],
    },
  ];
  const fieldLookup = new Map<string, DataSourceField>(fields.map((field) => [field.id, field]));
  const records: readonly DataRecord[] = MOCK_ROWS.map((row) => ({
    id: row.id,
    'column-provider': row['Encounter.Provider'],
    'column-status': row['Encounter.Status'],
    'column-balance': row['FinancialLedger.Balance'],
  }));
  const service = new CrosstabEngineService();

  it('aggregates row, column, and grand totals', () => {
    const matrix = service.createMatrix(records, MOCK_REPORT.crosstab, fieldLookup);
    const harperRow = matrix.rows.find((row) => row.labels.includes('Dr. Harper'));
    const footer = matrix.footerRows[0];

    expect(matrix.rows.length).toBe(3);
    expect(harperRow).toBeDefined();
    expect(harperRow?.cells['Completed::value-encounters']).toBe(2);
    expect(harperRow?.cells['Completed::value-balance']).toBe(54);
    expect(harperRow?.totalCells['value-encounters']).toBe(3);
    expect(harperRow?.totalCells['value-balance']).toBe(139);
    expect(footer?.totalCells['value-encounters']).toBe(8);
    expect(footer?.totalCells['value-balance']).toBe(389);
  });
});
