import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import {
  DataSourceField,
  DataSourceTable,
  FilterOperator,
  QueryColumn,
  QueryFilter,
  QueryJoinOperator,
  QueryJoinType,
  SortDirection,
} from '../../models/report-definition.model';
import {
  CanvasJoin,
  CanvasJoinCondition,
  QueryEditorStore,
} from '../../services/query-editor-store.service';

const joinTypes: readonly QueryJoinType[] = ['left', 'inner', 'right', 'full', 'cross'];
const sortDirections: readonly SortDirection[] = ['none', 'asc', 'desc'];
const filterOperators: readonly FilterOperator[] = [
  'equals',
  'notEquals',
  'contains',
  'greaterThan',
  'lessThan',
  'isEmpty',
];
const joinOperators: readonly QueryJoinOperator[] = [
  'equals',
  'notEquals',
  'greaterThan',
  'greaterThanOrEquals',
  'lessThan',
  'lessThanOrEquals',
];

@Component({
  selector: 'app-query-properties-panel',
  templateUrl: './query-properties-panel.component.html',
  styleUrl: './query-properties-panel.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class QueryPropertiesPanelComponent {
  protected readonly joinTypes = joinTypes;
  protected readonly sortDirections = sortDirections;
  protected readonly filterOperators = filterOperators;
  protected readonly joinOperators = joinOperators;
  protected readonly store = inject(QueryEditorStore);

  protected joinsForTable(tableId: string): readonly CanvasJoin[] {
    return this.store
      .canvasJoins()
      .filter((join) => join.fromTableId === tableId || join.toTableId === tableId);
  }

  protected selectedColumnsForTable(tableId: string): number {
    return this.store
      .selectedColumns()
      .filter((column) => this.store.fieldLookup().get(column.fieldId)?.tableId === tableId).length;
  }

  protected tableForField(field: DataSourceField): DataSourceTable | null {
    return this.store.tableLookup().get(field.tableId) ?? null;
  }

  protected isFieldSelected(fieldId: string): boolean {
    return this.store.selectedFieldIds().has(fieldId);
  }

  protected columnForField(fieldId: string): QueryColumn | null {
    return this.store.selectedColumns().find((column) => column.fieldId === fieldId) ?? null;
  }

  protected filtersForField(fieldId: string): readonly QueryFilter[] {
    return this.store.report().query.filters.filter((filter) => filter.fieldId === fieldId);
  }

  protected toggleFieldColumn(fieldId: string, event: Event): void {
    if (readCheckedValue(event)) {
      this.store.addColumn(fieldId);
    } else {
      this.store.removeColumnByFieldId(fieldId);
    }
  }

  protected includeAllTableFields(tableId: string): void {
    this.store.addColumnsForTable(tableId);
  }

  protected clearTableFields(tableId: string): void {
    this.store.removeColumnsForTable(tableId);
  }

  protected tablePositionX(tableId: string): number {
    return this.store.canvasTablePositions().get(tableId)?.x ?? 0;
  }

  protected tablePositionY(tableId: string): number {
    return this.store.canvasTablePositions().get(tableId)?.y ?? 0;
  }

  protected updateTablePositionX(tableId: string, event: Event): void {
    this.store.updateCanvasTablePosition(tableId, {
      x: readNumberValue(event),
      y: this.tablePositionY(tableId),
    });
  }

  protected updateTablePositionY(tableId: string, event: Event): void {
    this.store.updateCanvasTablePosition(tableId, {
      x: this.tablePositionX(tableId),
      y: readNumberValue(event),
    });
  }

  protected updateColumnAlias(columnId: string, event: Event): void {
    this.store.updateColumnAlias(columnId, readControlValue(event));
  }

  protected toggleColumnVisibility(columnId: string, event: Event): void {
    this.store.toggleColumnVisibility(columnId, readCheckedValue(event));
  }

  protected updateColumnSort(columnId: string, event: Event): void {
    this.store.updateColumnSort(columnId, readControlValue(event) as SortDirection);
  }

  protected updateColumnGroupBy(columnId: string, event: Event): void {
    this.store.updateColumnGroupBy(columnId, readCheckedValue(event));
  }

  protected updateColumnCriteria(columnId: string, event: Event): void {
    this.store.updateColumnCriteria(columnId, readControlValue(event));
  }

  protected updateColumnOrCriteria(columnId: string, index: number, event: Event): void {
    this.store.updateColumnOrCriteria(columnId, index, readControlValue(event));
  }

  protected addFilter(fieldId: string): void {
    this.store.addFilter(fieldId);
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

  protected removeFilter(filterId: string): void {
    this.store.removeFilter(filterId);
  }

  protected selectJoin(joinId: string): void {
    this.store.selectCanvasJoin(joinId);
  }

  protected updateJoinType(joinId: string, event: Event): void {
    this.store.updateJoinType(joinId, readControlValue(event) as QueryJoinType);
  }

  protected joinIssueSummary(join: CanvasJoin): string {
    return join.issues.map((issue) => issue.message).join(' ');
  }

  protected conditionIssueSummary(condition: CanvasJoinCondition): string {
    return condition.issues.map((issue) => issue.message).join(' ');
  }

  protected fieldsForTable(tableId: string): readonly DataSourceField[] {
    return this.store.tableLookup().get(tableId)?.fields ?? [];
  }

  protected joinOperatorLabel(operator: QueryJoinOperator): string {
    switch (operator) {
      case 'notEquals':
        return '<>';
      case 'greaterThan':
        return '>';
      case 'greaterThanOrEquals':
        return '>=';
      case 'lessThan':
        return '<';
      case 'lessThanOrEquals':
        return '<=';
      case 'equals':
        return '=';
    }
  }

  protected filterOperatorLabel(operator: FilterOperator): string {
    switch (operator) {
      case 'notEquals':
        return 'not equals';
      case 'greaterThan':
        return 'greater than';
      case 'lessThan':
        return 'less than';
      case 'isEmpty':
        return 'is empty';
      case 'contains':
      case 'equals':
        return operator;
    }
  }

  protected addJoinCondition(joinId: string): void {
    this.store.addJoinCondition(joinId);
  }

  protected canAddJoinCondition(joinId: string): boolean {
    return this.store.canAddJoinCondition(joinId);
  }

  protected suggestedJoinConditionLabel(joinId: string): string {
    return this.store.suggestedJoinConditionLabel(joinId);
  }

  protected removeJoinCondition(joinId: string, conditionId: string): void {
    this.store.removeJoinCondition(joinId, conditionId);
  }

  protected updateJoinConditionFromField(joinId: string, conditionId: string, event: Event): void {
    this.store.updateJoinConditionFromField(joinId, conditionId, readControlValue(event));
  }

  protected updateJoinConditionOperator(joinId: string, conditionId: string, event: Event): void {
    this.store.updateJoinConditionOperator(
      joinId,
      conditionId,
      readControlValue(event) as QueryJoinOperator,
    );
  }

  protected updateJoinConditionToField(joinId: string, conditionId: string, event: Event): void {
    this.store.updateJoinConditionToField(joinId, conditionId, readControlValue(event));
  }

  protected removeJoin(joinId: string): void {
    this.store.removeJoin(joinId);
  }

  protected removeSourceTable(tableId: string): void {
    this.store.removeSourceTable(tableId);
  }

  protected clearSelection(): void {
    this.store.clearCanvasSelection();
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

function readNumberValue(event: Event): number {
  const target = event.target;

  return target instanceof HTMLInputElement ? Number(target.value) || 0 : 0;
}
