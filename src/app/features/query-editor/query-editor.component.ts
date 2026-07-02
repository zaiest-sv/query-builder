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
  FilterOperator,
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
  protected readonly aggregations = aggregations;
  protected readonly activeTab = signal<EditorTab>('query');
  protected readonly filterFieldId = signal(this.store.fieldsForSelectedSources()[0]?.id ?? '');
  protected readonly crosstabRowFieldId = signal('Encounter.Provider');
  protected readonly crosstabColumnFieldId = signal('Encounter.Status');
  protected readonly crosstabValueFieldId = signal('Encounter.EncounterId');
  protected readonly crosstabAggregation = signal<CrosstabAggregation>('count');
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

  protected setActiveTab(tab: EditorTab): void {
    this.activeTab.set(tab);
  }

  protected setColumnGridHeight(height: number): void {
    this.columnGridHeight.set(height);
  }

  protected setFilterField(event: Event): void {
    this.filterFieldId.set(readControlValue(event));
  }

  protected addFilter(): void {
    this.store.addFilter(this.filterFieldId());
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
    this.store.addCrosstabRow(this.crosstabRowFieldId());
  }

  protected addCrosstabColumn(): void {
    this.store.addCrosstabColumn(this.crosstabColumnFieldId());
  }

  protected addCrosstabValue(): void {
    this.store.addCrosstabValue(this.crosstabValueFieldId(), this.crosstabAggregation());
  }

  protected fieldLabel(fieldId: string): string {
    return this.store.fieldLookup().get(fieldId)?.label ?? fieldId;
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
    return this.store.fieldLookup().get(fieldId)?.aggregations.includes(aggregation) ?? false;
  }

  protected setIncludeRowTotals(event: Event): void {
    this.store.setIncludeRowTotals(readCheckedValue(event));
  }

  protected setIncludeColumnTotals(event: Event): void {
    this.store.setIncludeColumnTotals(readCheckedValue(event));
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
