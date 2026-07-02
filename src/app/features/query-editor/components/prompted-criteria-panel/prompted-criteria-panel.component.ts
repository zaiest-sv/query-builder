import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import {
  DataSourceField,
  FieldType,
  FilterOperator,
  QueryFilter,
  QueryParameter,
} from '../../models/report-definition.model';
import { QueryEditorStore } from '../../services/query-editor-store.service';

const filterOperators: readonly FilterOperator[] = [
  'equals',
  'notEquals',
  'contains',
  'greaterThan',
  'lessThan',
  'isEmpty',
];
const fieldTypes: readonly FieldType[] = ['string', 'number', 'date', 'boolean'];

@Component({
  selector: 'app-prompted-criteria-panel',
  templateUrl: './prompted-criteria-panel.component.html',
  styleUrl: '../../query-editor.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PromptedCriteriaPanelComponent {
  protected readonly store = inject(QueryEditorStore);
  protected readonly filterOperators = filterOperators;
  protected readonly fieldTypes = fieldTypes;
  protected readonly filterFieldId = signal(this.store.fieldsForSelectedSources()[0]?.id ?? '');
  protected readonly activeFilterFieldId = computed(() => {
    const fields = this.store.fieldsForSelectedSources();
    const selectedFieldId = this.filterFieldId();

    return fields.some((field) => field.id === selectedFieldId)
      ? selectedFieldId
      : (fields[0]?.id ?? '');
  });

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

  protected fieldLabel(fieldId: string): string {
    return this.store.fieldLookup().get(fieldId)?.label ?? fieldId;
  }

  protected fieldForColumn(fieldId: string): DataSourceField | null {
    return this.store.fieldLookup().get(fieldId) ?? null;
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
