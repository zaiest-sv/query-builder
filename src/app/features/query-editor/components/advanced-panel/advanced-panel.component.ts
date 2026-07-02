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
}
