import {
  ChangeDetectionStrategy,
  Component,
  EventEmitter,
  Input,
  OnChanges,
  Output,
  SimpleChanges,
  signal,
} from '@angular/core';

@Component({
  selector: 'app-query-expression-editor-modal',
  templateUrl: './query-expression-editor-modal.component.html',
  styleUrl: './query-expression-editor-modal.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class QueryExpressionEditorModalComponent implements OnChanges {
  @Input() title = 'Edit expression';
  @Input() label = 'Expression';
  @Input() value = '';
  @Input() helperText = '';
  @Input() placeholder = '';
  @Output() readonly save = new EventEmitter<string>();
  @Output() readonly cancel = new EventEmitter<void>();

  protected readonly draft = signal('');

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['value']) {
      this.draft.set(this.value);
    }
  }

  protected setDraft(event: Event): void {
    const target = event.target;

    if (target instanceof HTMLTextAreaElement) {
      this.draft.set(target.value);
    }
  }

  protected saveDraft(): void {
    this.save.emit(this.draft());
  }
}
