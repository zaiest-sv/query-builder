import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import {
  CellValue,
  DataSourceField,
  PreviewRow,
  QueryColumn,
  QueryParameter,
} from '../../models/report-definition.model';
import { QueryEditorStore } from '../../services/query-editor-store.service';

@Component({
  selector: 'app-preview-panel',
  templateUrl: './preview-panel.component.html',
  styleUrl: '../../query-editor.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PreviewPanelComponent {
  protected readonly store = inject(QueryEditorStore);

  protected previewColumns(): readonly QueryColumn[] {
    const serverPreview = this.store.serverPreview();

    return serverPreview.status === 'ready' || serverPreview.status === 'invalid'
      ? serverPreview.columns
      : this.store.activePreviewColumns();
  }

  protected previewRows(): readonly PreviewRow[] {
    const serverPreview = this.store.serverPreview();

    return serverPreview.status === 'ready' || serverPreview.status === 'invalid'
      ? serverPreview.rows
      : this.store.activePreviewRows();
  }

  protected previewRowSourceLabel(): string {
    const serverPreview = this.store.serverPreview();

    return serverPreview.status === 'ready' || serverPreview.status === 'invalid'
      ? 'server'
      : 'local';
  }

  protected runPreview(): void {
    this.store.runServerPreview(this.store.activeSubquery()?.settings?.previewLimit ?? 100);
  }

  protected validatePreview(): void {
    this.store.validateOnServer();
  }

  protected updateParameterValue(parameterId: string, event: Event): void {
    this.store.updateParameterDefaultValue(parameterId, readControlValue(event));
  }

  protected parameterInputType(parameter: QueryParameter): string {
    if (parameter.type === 'date') {
      return 'date';
    }

    if (parameter.type === 'number') {
      return 'number';
    }

    return 'text';
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
