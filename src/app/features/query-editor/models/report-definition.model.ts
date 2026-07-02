export type FieldType = 'string' | 'number' | 'date' | 'boolean';

export type SortDirection = 'none' | 'asc' | 'desc';

export type QueryJoinType = 'inner' | 'left' | 'right' | 'full' | 'cross';

export type QueryJoinOperator =
  | 'equals'
  | 'notEquals'
  | 'greaterThan'
  | 'greaterThanOrEquals'
  | 'lessThan'
  | 'lessThanOrEquals';

export type FilterOperator =
  | 'equals'
  | 'notEquals'
  | 'contains'
  | 'greaterThan'
  | 'lessThan'
  | 'isEmpty';

export type CrosstabAggregation = 'count' | 'sum' | 'avg' | 'min' | 'max';

export type SaveStatus = 'idle' | 'saving' | 'saved' | 'invalid' | 'error';

export type CellValue = string | number | boolean | null;

export interface DataSourceField {
  readonly id: string;
  readonly tableId: string;
  readonly name: string;
  readonly label: string;
  readonly expression: string;
  readonly type: FieldType;
  readonly nullable: boolean;
  readonly aggregations: readonly CrosstabAggregation[];
}

export interface DataSourceTable {
  readonly id: string;
  readonly schema: string;
  readonly name: string;
  readonly alias: string;
  readonly label: string;
  readonly fields: readonly DataSourceField[];
}

export interface DataSourceGroup {
  readonly id: string;
  readonly label: string;
  readonly tables: readonly DataSourceTable[];
}

export interface DataRecord {
  readonly id: string;
  readonly [fieldId: string]: CellValue;
}

export interface QueryColumn {
  readonly id: string;
  readonly fieldId: string;
  readonly expression: string;
  readonly alias: string;
  readonly visible: boolean;
  readonly sortDirection: SortDirection;
  readonly sortOrder?: number;
  readonly groupBy?: boolean;
  readonly criteria?: string;
  readonly orCriteria?: readonly string[];
}

export interface QueryFilter {
  readonly id: string;
  readonly fieldId: string;
  readonly operator: FilterOperator;
  readonly value: string;
  readonly parameterName: string;
}

export interface QueryJoinCondition {
  readonly id: string;
  readonly fromFieldId: string;
  readonly operator: QueryJoinOperator;
  readonly toFieldId: string;
}

export interface QueryJoin {
  readonly id: string;
  readonly type: QueryJoinType;
  readonly conditions: readonly QueryJoinCondition[];
}

export interface QueryParameter {
  readonly id: string;
  readonly name: string;
  readonly label: string;
  readonly type: FieldType;
  readonly required: boolean;
  readonly defaultValue: string;
}

export interface QueryCanvasTablePosition {
  readonly tableId: string;
  readonly x: number;
  readonly y: number;
}

export interface QueryCanvasLayout {
  readonly tables: readonly QueryCanvasTablePosition[];
}

export interface QueryDocument {
  readonly sourceTableIds: readonly string[];
  readonly columns: readonly QueryColumn[];
  readonly filters: readonly QueryFilter[];
  readonly joins: readonly QueryJoin[];
  readonly layout: QueryCanvasLayout;
  readonly parameters: readonly QueryParameter[];
}

export interface CrosstabValueDefinition {
  readonly id: string;
  readonly fieldId: string;
  readonly label: string;
  readonly aggregation: CrosstabAggregation;
}

export interface CrosstabDefinition {
  readonly rowFieldIds: readonly string[];
  readonly columnFieldIds: readonly string[];
  readonly values: readonly CrosstabValueDefinition[];
  readonly includeRowTotals: boolean;
  readonly includeColumnTotals: boolean;
}

export interface ReportDefinition {
  readonly id: string;
  readonly tenantName: string;
  readonly reportName: string;
  readonly description: string;
  readonly query: QueryDocument;
  readonly crosstab: CrosstabDefinition;
}

export interface PreviewRow {
  readonly id: string;
  readonly cells: Readonly<Record<string, CellValue>>;
}

export interface CrosstabValueColumn {
  readonly key: string;
  readonly label: string;
  readonly valueId: string;
  readonly columnKey: string;
}

export interface CrosstabColumnGroup {
  readonly key: string;
  readonly label: string;
  readonly values: readonly CrosstabValueColumn[];
}

export interface CrosstabMatrixRow {
  readonly key: string;
  readonly labels: readonly string[];
  readonly cells: Readonly<Record<string, number>>;
  readonly totalCells: Readonly<Record<string, number>>;
}

export interface CrosstabFooterRow {
  readonly labels: readonly string[];
  readonly cells: Readonly<Record<string, number>>;
  readonly totalCells: Readonly<Record<string, number>>;
}

export interface CrosstabMatrix {
  readonly rowFields: readonly DataSourceField[];
  readonly columnFields: readonly DataSourceField[];
  readonly valueDefinitions: readonly CrosstabValueDefinition[];
  readonly columnGroups: readonly CrosstabColumnGroup[];
  readonly rows: readonly CrosstabMatrixRow[];
  readonly footerRows: readonly CrosstabFooterRow[];
}

export interface SaveState {
  readonly status: SaveStatus;
  readonly message: string;
  readonly savedAt?: string;
}
