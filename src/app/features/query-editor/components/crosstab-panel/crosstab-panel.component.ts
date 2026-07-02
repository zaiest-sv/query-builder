import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { CellValue, CrosstabAggregation } from '../../models/report-definition.model';
import { QueryEditorStore } from '../../services/query-editor-store.service';

const aggregations: readonly CrosstabAggregation[] = ['count', 'sum', 'avg', 'min', 'max'];

@Component({
  selector: 'app-crosstab-panel',
  templateUrl: './crosstab-panel.component.html',
  styleUrl: '../../query-editor.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CrosstabPanelComponent {
  protected readonly store = inject(QueryEditorStore);
  protected readonly aggregations = aggregations;
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

  protected crosstabFieldLabel(fieldId: string): string {
    return this.store.crosstabFieldLookup().get(fieldId)?.label ?? fieldId;
  }

  protected crosstabFieldType(fieldId: string): string {
    return this.store.crosstabFieldLookup().get(fieldId)?.type ?? 'missing';
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

  protected exportCrosstabCsv(): void {
    const matrix = this.store.crosstabMatrix();

    if (!this.canRenderCrosstab() || matrix.rows.length === 0) {
      return;
    }

    const header = [
      ...matrix.rowFields.map((field) => field.label),
      ...matrix.columnGroups.flatMap((columnGroup) =>
        columnGroup.values.map((value) => `${columnGroup.label} ${value.label}`),
      ),
      ...(this.store.report().crosstab.includeRowTotals
        ? matrix.valueDefinitions.map((value) => `Row total ${value.aggregation} ${value.label}`)
        : []),
    ];
    const bodyRows = matrix.rows.map((row) => [
      ...row.labels,
      ...matrix.columnGroups.flatMap((columnGroup) =>
        columnGroup.values.map((value) => row.cells[value.key] ?? 0),
      ),
      ...(this.store.report().crosstab.includeRowTotals
        ? matrix.valueDefinitions.map((value) => row.totalCells[value.id] ?? 0)
        : []),
    ]);
    const footerRows = matrix.footerRows.map((footerRow) => [
      ...footerRow.labels,
      ...Array(Math.max(matrix.rowFields.length - footerRow.labels.length, 0)).fill(''),
      ...matrix.columnGroups.flatMap((columnGroup) =>
        columnGroup.values.map((value) => footerRow.cells[value.key] ?? 0),
      ),
      ...(this.store.report().crosstab.includeRowTotals
        ? matrix.valueDefinitions.map((value) => footerRow.totalCells[value.id] ?? 0)
        : []),
    ]);
    const csv = [header, ...bodyRows, ...footerRows]
      .map((row) => row.map((value) => escapeCsvValue(value)).join(','))
      .join('\n');

    downloadTextFile(csv, `${safeFileName(this.store.report().reportName)}-crosstab.csv`);
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

function escapeCsvValue(value: CellValue | number): string {
  const text = String(value ?? '');

  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function safeFileName(value: string): string {
  return (
    value
      .trim()
      .replace(/[^A-Za-z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'report'
  );
}

function downloadTextFile(content: string, fileName: string): void {
  if (typeof document === 'undefined') {
    return;
  }

  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');

  link.href = url;
  link.download = fileName;
  link.click();
  URL.revokeObjectURL(url);
}
