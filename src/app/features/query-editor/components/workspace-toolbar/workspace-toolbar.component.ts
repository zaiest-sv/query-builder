import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { QueryEditorStore } from '../../services/query-editor-store.service';

@Component({
  selector: 'app-workspace-toolbar',
  templateUrl: './workspace-toolbar.component.html',
  styleUrl: './workspace-toolbar.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class WorkspaceToolbarComponent {
  protected readonly store = inject(QueryEditorStore);
}
