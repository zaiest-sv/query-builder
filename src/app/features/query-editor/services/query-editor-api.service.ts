import { inject, Injectable, InjectionToken } from '@angular/core';
import { Observable, of } from 'rxjs';
import { DATA_SOURCE_GROUPS, MOCK_REPORT, MOCK_ROWS } from '../data/mock-report-data';
import {
  DataRecord,
  DataSourceGroup,
  QueryJoin,
  QueryJoinCondition,
  QueryJoinOperator,
  QueryJoinType,
  ReportDefinition,
} from '../models/report-definition.model';

const mockReportStorageKey = 'query-builder.mock-report';

export interface QueryEditorData {
  readonly metadata: readonly DataSourceGroup[];
  readonly report: ReportDefinition;
  readonly rows: readonly DataRecord[];
}

export interface SaveReportResponse {
  readonly report: ReportDefinition;
  readonly savedAt: string;
  readonly message: string;
}

export interface QueryEditorApi {
  loadReport(reportId: string): Observable<QueryEditorData>;
  saveReport(report: ReportDefinition): Observable<SaveReportResponse>;
}

@Injectable({ providedIn: 'root' })
export class MockQueryEditorApiService implements QueryEditorApi {
  private report = readStoredReport() ?? cloneReport(MOCK_REPORT);

  loadReport(reportId: string): Observable<QueryEditorData> {
    const report = reportId === this.report.id ? this.report : MOCK_REPORT;

    return of({
      metadata: cloneValue(DATA_SOURCE_GROUPS),
      report: cloneReport(report),
      rows: cloneValue(MOCK_ROWS),
    });
  }

  saveReport(report: ReportDefinition): Observable<SaveReportResponse> {
    this.report = cloneReport(report);
    writeStoredReport(this.report);

    return of({
      report: cloneReport(this.report),
      savedAt: new Date().toISOString(),
      message: 'Mock report definition saved',
    });
  }
}

export const QUERY_EDITOR_API = new InjectionToken<QueryEditorApi>('QueryEditorApi', {
  providedIn: 'root',
  factory: () => inject(MockQueryEditorApiService),
});

function cloneReport(report: ReportDefinition): ReportDefinition {
  return normalizeReport(cloneValue(report));
}

function cloneValue<T>(value: T): T {
  return structuredClone(value);
}

function normalizeReport(report: ReportDefinition): ReportDefinition {
  const query = report.query as ReportDefinition['query'] & {
    readonly layout?: ReportDefinition['query']['layout'];
    readonly joins?: readonly unknown[];
  };

  return {
    ...report,
    query: {
      ...report.query,
      joins: (query.joins ?? []).map(normalizeJoin).filter((join): join is QueryJoin => join !== null),
      layout: query.layout ?? { tables: [] },
    },
  };
}

function normalizeJoin(value: unknown, index: number): QueryJoin | null {
  if (!isRecord(value)) {
    return null;
  }

  const joinId = readString(value['id']) || `join-${index + 1}`;
  const type = readJoinType(value['type']);
  const rawConditions = Array.isArray(value['conditions'])
    ? value['conditions']
    : [
        {
          id: `${joinId}-condition-1`,
          fromFieldId: value['fromFieldId'],
          operator: 'equals',
          toFieldId: value['toFieldId'],
        },
      ];
  const conditions = rawConditions
    .map((condition, conditionIndex) => normalizeJoinCondition(joinId, condition, conditionIndex))
    .filter((condition): condition is QueryJoinCondition => condition !== null);

  return conditions.length > 0
    ? {
        id: joinId,
        type,
        conditions,
      }
    : null;
}

function normalizeJoinCondition(
  joinId: string,
  value: unknown,
  index: number,
): QueryJoinCondition | null {
  if (!isRecord(value)) {
    return null;
  }

  const fromFieldId = readString(value['fromFieldId']);
  const toFieldId = readString(value['toFieldId']);

  if (!fromFieldId || !toFieldId) {
    return null;
  }

  return {
    id: readString(value['id']) || `${joinId}-condition-${index + 1}`,
    fromFieldId,
    operator: readJoinOperator(value['operator']),
    toFieldId,
  };
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function readJoinType(value: unknown): QueryJoinType {
  return value === 'inner' || value === 'right' || value === 'full' || value === 'cross'
    ? value
    : 'left';
}

function readJoinOperator(value: unknown): QueryJoinOperator {
  return value === 'notEquals' ||
    value === 'greaterThan' ||
    value === 'greaterThanOrEquals' ||
    value === 'lessThan' ||
    value === 'lessThanOrEquals'
    ? value
    : 'equals';
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null;
}

function readStoredReport(): ReportDefinition | null {
  try {
    const storedReport = globalThis.localStorage?.getItem(mockReportStorageKey);

    return storedReport ? normalizeReport(JSON.parse(storedReport) as ReportDefinition) : null;
  } catch {
    return null;
  }
}

function writeStoredReport(report: ReportDefinition): void {
  try {
    globalThis.localStorage?.setItem(mockReportStorageKey, JSON.stringify(report));
  } catch {
    // Mock persistence is best-effort only.
  }
}
