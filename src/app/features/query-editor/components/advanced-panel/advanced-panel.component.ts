import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { QueryEditorStore } from '../../services/query-editor-store.service';

@Component({
  selector: 'app-advanced-panel',
  templateUrl: './advanced-panel.component.html',
  styleUrl: '../../query-editor.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AdvancedPanelComponent {
  protected readonly store = inject(QueryEditorStore);

  protected runServerValidation(): void {
    this.store.validateOnServer();
  }

  protected runServerPreview(): void {
    this.store.runServerPreview(this.store.activeSubquery()?.settings?.previewLimit ?? 100);
  }

  protected downloadSql(): void {
    downloadTextFile(
      this.store.activeSql(),
      `${safeFileName(this.store.report().reportName)}-${safeFileName(this.store.activeQueryLabel())}.sql`,
    );
  }
}

function downloadTextFile(content: string, fileName: string): void {
  const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');

  link.href = url;
  link.download = fileName;
  link.click();
  URL.revokeObjectURL(url);
}

function safeFileName(value: string): string {
  return (
    value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'query'
  );
}
