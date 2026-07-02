import {
  DataRecord,
  DataSourceGroup,
  PreviewRow,
  QueryDocument,
  ReportDefinition,
} from './report-definition.model';

export interface QueryEditorSchemaResponse {
  readonly metadata: readonly DataSourceGroup[];
}

export interface QueryEditorReportLoadRequest {
  readonly reportId: string;
}

export interface QueryEditorReportLoadResponse {
  readonly report: ReportDefinition;
  readonly metadata: readonly DataSourceGroup[];
}

export interface QueryEditorReportSaveRequest {
  readonly report: ReportDefinition;
  readonly expectedVersion?: string;
}

export interface QueryEditorReportSaveResponse {
  readonly report: ReportDefinition;
  readonly version?: string;
  readonly savedAt: string;
  readonly message: string;
}

export interface QueryEditorValidationRequest {
  readonly report: ReportDefinition;
  readonly queryId: 'main' | string;
}

export interface QueryEditorValidationResponse {
  readonly issues: readonly string[];
}

export interface QueryEditorPreviewRequest {
  readonly report: ReportDefinition;
  readonly query: QueryDocument;
  readonly queryId: 'main' | string;
  readonly parameters: Readonly<Record<string, string>>;
  readonly limit: number;
  readonly offset: number;
}

export interface QueryEditorPreviewResponse {
  readonly columns: readonly string[];
  readonly rows: readonly PreviewRow[];
  readonly sourceRows?: readonly DataRecord[];
  readonly totalCount: number;
  readonly issues: readonly string[];
}
