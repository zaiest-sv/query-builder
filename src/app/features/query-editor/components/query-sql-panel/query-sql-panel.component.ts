import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { QueryEditorStore } from '../../services/query-editor-store.service';

@Component({
  selector: 'app-query-sql-panel',
  templateUrl: './query-sql-panel.component.html',
  styleUrl: './query-sql-panel.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class QuerySqlPanelComponent {
  protected readonly store = inject(QueryEditorStore);
}
