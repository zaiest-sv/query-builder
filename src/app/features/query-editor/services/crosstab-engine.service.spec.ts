import { DATA_SOURCE_GROUPS, MOCK_REPORT, MOCK_ROWS } from '../data/mock-report-data';
import { DataSourceField } from '../models/report-definition.model';
import { CrosstabEngineService } from './crosstab-engine.service';

describe('CrosstabEngineService', () => {
  const fields = DATA_SOURCE_GROUPS.flatMap((group) => group.tables).flatMap((table) => table.fields);
  const fieldLookup = new Map<string, DataSourceField>(fields.map((field) => [field.id, field]));
  const service = new CrosstabEngineService();

  it('aggregates row, column, and grand totals', () => {
    const matrix = service.createMatrix(MOCK_ROWS, MOCK_REPORT.crosstab, fieldLookup);
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
