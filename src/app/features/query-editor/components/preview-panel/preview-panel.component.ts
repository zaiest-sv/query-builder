import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { CellValue, DataSourceField } from '../../models/report-definition.model';
import { QueryEditorStore } from '../../services/query-editor-store.service';

@Component({
  selector: 'app-preview-panel',
  templateUrl: './preview-panel.component.html',
  styleUrl: '../../query-editor.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PreviewPanelComponent {
  protected readonly store = inject(QueryEditorStore);

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
