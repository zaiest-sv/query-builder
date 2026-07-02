import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { QueryEditorStore } from '../../services/query-editor-store.service';

@Component({
  selector: 'app-query-sql-panel',
  templateUrl: './query-sql-panel.component.html',
  styleUrl: './query-sql-panel.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    '[class.query-side-card--collapsed]': 'isCollapsed()',
  },
})
export class QuerySqlPanelComponent {
  protected readonly store = inject(QueryEditorStore);
  protected readonly isCollapsed = signal(false);

  protected toggleCollapsed(): void {
    this.isCollapsed.update((isCollapsed) => !isCollapsed);
  }
}
