import { ChangeDetectionStrategy, Component } from '@angular/core';
import { QueryEditorComponent } from './features/query-editor/query-editor.component';

@Component({
  selector: 'app-root',
  imports: [QueryEditorComponent],
  templateUrl: './app.html',
  styleUrl: './app.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class App {}
