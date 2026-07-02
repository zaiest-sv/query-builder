import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { DatasourcePanelComponent } from './components/datasource-panel/datasource-panel.component';
import { QueryCanvasComponent } from './components/query-canvas/query-canvas.component';
import { QueryColumnGridComponent } from './components/query-column-grid/query-column-grid.component';
import { QueryPropertiesPanelComponent } from './components/query-properties-panel/query-properties-panel.component';
import { QuerySqlPanelComponent } from './components/query-sql-panel/query-sql-panel.component';
import { WorkspaceToolbarComponent } from './components/workspace-toolbar/workspace-toolbar.component';
import {
  CellValue,
  CrosstabAggregation,
  DataSourceField,
  FieldType,
  FilterOperator,
  QueryFilter,
  QueryParameter,
} from './models/report-definition.model';
import { QueryEditorStore } from './services/query-editor-store.service';

type EditorTab = 'query' | 'criteria' | 'preview' | 'crosstab' | 'advanced';

interface EditorTabItem {
  readonly id: EditorTab;
  readonly label: string;
}

const tabs: readonly EditorTabItem[] = [
  { id: 'query', label: 'Query Editor' },
  { id: 'criteria', label: 'Prompted Criteria' },
  { id: 'preview', label: 'Preview' },
  { id: 'crosstab', label: 'Crosstab' },
  { id: 'advanced', label: 'Advanced' },
];

const filterOperators: readonly FilterOperator[] = [
  'equals',
  'notEquals',
  'contains',
  'greaterThan',
  'lessThan',
  'isEmpty',
];
const fieldTypes: readonly FieldType[] = ['string', 'number', 'date', 'boolean'];
const aggregations: readonly CrosstabAggregation[] = ['count', 'sum', 'avg', 'min', 'max'];
const columnGridResizerHeight = 12;
const defaultColumnGridHeight = 132;

@Component({
  selector: 'app-query-editor',
  imports: [
    DatasourcePanelComponent,
    QueryCanvasComponent,
    QueryColumnGridComponent,
    QueryPropertiesPanelComponent,
    QuerySqlPanelComponent,
    WorkspaceToolbarComponent,
  ],
  templateUrl: './query-editor.component.html',
  styleUrl: './query-editor.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class QueryEditorComponent {
  protected readonly store = inject(QueryEditorStore);
  protected readonly tabs = tabs;
  protected readonly filterOperators = filterOperators;
  protected readonly fieldTypes = fieldTypes;
  protected readonly aggregations = aggregations;
  protected readonly activeTab = signal<EditorTab>('query');
  protected readonly filterFieldId = signal(this.store.fieldsForSelectedSources()[0]?.id ?? '');
  protected readonly activeFilterFieldId = computed(() => {
    const fields = this.store.fieldsForSelectedSources();
    const selectedFieldId = this.filterFieldId();

    return fields.some((field) => field.id === selectedFieldId)
      ? selectedFieldId
      : (fields[0]?.id ?? '');
  });
  protected readonly crosstabRowFieldId = signal('column-provider');
  protected readonly crosstabColumnFieldId = signal('column-status');
  protected readonly crosstabValueFieldId = signal('column-balance');
  protected readonly crosstabAggregation = signal<CrosstabAggregation>('count');
  protected readonly activeCrosstabRowFieldId = computed(() =>
    this.resolveCrosstabFieldId(this.crosstabRowFieldId()),
  );
  protected readonly activeCrosstabColumnFieldId = computed(() =>
    this.resolveCrosstabFieldId(this.crosstabColumnFieldId()),
  );
  protected readonly activeCrosstabValueFieldId = computed(() =>
    this.resolveCrosstabFieldId(this.crosstabValueFieldId()),
  );
  protected readonly columnGridHeight = signal(defaultColumnGridHeight);
  protected readonly columnGridPanelHeight = computed(
    () => `${this.columnGridHeight() + columnGridResizerHeight}px`,
  );
  protected readonly valueColumnCount = computed(() => {
    const matrix = this.store.crosstabMatrix();
    const baseCount = matrix.columnGroups.reduce((total, group) => total + group.values.length, 0);
    const totalCount = this.store.report().crosstab.includeRowTotals
      ? matrix.valueDefinitions.length
      : 0;

    return baseCount + totalCount;
  });
  protected readonly crosstabCellCount = computed(
    () => this.store.crosstabMatrix().rows.length * this.valueColumnCount(),
  );
  protected readonly canRenderCrosstab = computed(() => {
    const matrix = this.store.crosstabMatrix();

    return (
      matrix.rowFields.length > 0 &&
      matrix.columnFields.length > 0 &&
      matrix.valueDefinitions.length > 0
    );
  });

  protected setActiveTab(tab: EditorTab): void {
    if (tab === 'crosstab') {
      this.store.selectMainQuery();
    }

    this.activeTab.set(tab);
  }

  protected setColumnGridHeight(height: number): void {
    this.columnGridHeight.set(height);
  }

  protected setFilterField(event: Event): void {
    this.filterFieldId.set(readControlValue(event));
  }

  protected addFilter(): void {
    const fieldId = this.activeFilterFieldId();

    if (fieldId) {
      this.store.addFilter(fieldId);
    }
  }

  protected updateFilterOperator(filterId: string, event: Event): void {
    this.store.updateFilterOperator(filterId, readControlValue(event) as FilterOperator);
  }

  protected updateFilterValue(filterId: string, event: Event): void {
    this.store.updateFilterValue(filterId, readControlValue(event));
  }

  protected updateFilterParameter(filterId: string, event: Event): void {
    this.store.updateFilterParameter(filterId, readControlValue(event));
  }

  protected addParameter(): void {
    this.store.addParameter();
  }

  protected addParameterForFilter(filterId: string): void {
    this.store.addParameterForFilter(filterId);
  }

  protected updateParameterName(parameterId: string, event: Event): void {
    this.store.updateParameterName(parameterId, readControlValue(event));
  }

  protected updateParameterLabel(parameterId: string, event: Event): void {
    this.store.updateParameterLabel(parameterId, readControlValue(event));
  }

  protected updateParameterType(parameterId: string, event: Event): void {
    this.store.updateParameterType(parameterId, readControlValue(event) as FieldType);
  }

  protected updateParameterRequired(parameterId: string, event: Event): void {
    this.store.updateParameterRequired(parameterId, readCheckedValue(event));
  }

  protected updateParameterDefaultValue(parameterId: string, event: Event): void {
    this.store.updateParameterDefaultValue(parameterId, readControlValue(event));
  }

  protected removeParameter(parameterId: string): void {
    this.store.removeParameter(parameterId);
  }

  protected parameterForFilter(filter: QueryFilter): QueryParameter | null {
    return (
      this.store
        .activeQuery()
        .parameters.find((parameter) => parameter.name === filter.parameterName) ?? null
    );
  }

  protected filterValueInputType(filter: QueryFilter): string {
    const field = this.store.fieldLookup().get(filter.fieldId);

    if (field?.type === 'date') {
      return 'date';
    }

    if (field?.type === 'number') {
      return 'number';
    }

    return 'text';
  }

  protected setCrosstabRowField(event: Event): void {
    this.crosstabRowFieldId.set(readControlValue(event));
  }

  protected setCrosstabColumnField(event: Event): void {
    this.crosstabColumnFieldId.set(readControlValue(event));
  }

  protected setCrosstabValueField(event: Event): void {
    this.crosstabValueFieldId.set(readControlValue(event));
  }

  protected setCrosstabAggregation(event: Event): void {
    this.crosstabAggregation.set(readControlValue(event) as CrosstabAggregation);
  }

  protected addCrosstabRow(): void {
    const fieldId = this.activeCrosstabRowFieldId();

    if (fieldId) {
      this.store.addCrosstabRow(fieldId);
    }
  }

  protected addCrosstabColumn(): void {
    const fieldId = this.activeCrosstabColumnFieldId();

    if (fieldId) {
      this.store.addCrosstabColumn(fieldId);
    }
  }

  protected addCrosstabValue(): void {
    const fieldId = this.activeCrosstabValueFieldId();

    if (fieldId) {
      this.store.addCrosstabValue(fieldId, this.crosstabAggregation());
    }
  }

  protected moveCrosstabRow(fieldId: string, direction: -1 | 1): void {
    this.store.moveCrosstabRow(fieldId, direction);
  }

  protected moveCrosstabColumn(fieldId: string, direction: -1 | 1): void {
    this.store.moveCrosstabColumn(fieldId, direction);
  }

  protected moveCrosstabValue(valueId: string, direction: -1 | 1): void {
    this.store.moveCrosstabValue(valueId, direction);
  }

  protected fieldLabel(fieldId: string): string {
    return this.store.fieldLookup().get(fieldId)?.label ?? fieldId;
  }

  protected crosstabFieldLabel(fieldId: string): string {
    return this.store.crosstabFieldLookup().get(fieldId)?.label ?? fieldId;
  }

  protected crosstabFieldType(fieldId: string): string {
    return this.store.crosstabFieldLookup().get(fieldId)?.type ?? 'missing';
  }

  protected fieldForColumn(fieldId: string): DataSourceField | null {
    return this.store.fieldLookup().get(fieldId) ?? null;
  }

  protected formatValue(value: CellValue | number): string {
    if (value === null || value === '') {
      return '-';
    }

    if (typeof value === 'number') {
      return Number.isInteger(value) ? String(value) : value.toFixed(2);
    }

    if (typeof value === 'boolean') {
      return value ? 'Yes' : 'No';
    }

    return String(value);
  }

  protected canUseAggregation(fieldId: string, aggregation: CrosstabAggregation): boolean {
    return (
      this.store.crosstabFieldLookup().get(fieldId)?.aggregations.includes(aggregation) ?? false
    );
  }

  protected canAddCrosstabValue(fieldId: string, aggregation: CrosstabAggregation): boolean {
    return (
      this.canUseAggregation(fieldId, aggregation) &&
      !this.store
        .crosstabDefinition()
        .values.some((value) => value.fieldId === fieldId && value.aggregation === aggregation)
    );
  }

  protected setIncludeRowTotals(event: Event): void {
    this.store.setIncludeRowTotals(readCheckedValue(event));
  }

  protected setIncludeColumnTotals(event: Event): void {
    this.store.setIncludeColumnTotals(readCheckedValue(event));
  }

  private resolveCrosstabFieldId(fieldId: string): string {
    const fields = this.store.crosstabFields();

    return fields.some((field) => field.id === fieldId) ? fieldId : (fields[0]?.id ?? '');
  }
}

function readControlValue(event: Event): string {
  const target = event.target;

  if (
    target instanceof HTMLInputElement ||
    target instanceof HTMLSelectElement ||
    target instanceof HTMLTextAreaElement
  ) {
    return target.value;
  }

  return '';
}

function readCheckedValue(event: Event): boolean {
  const target = event.target;

  return target instanceof HTMLInputElement ? target.checked : false;
}
