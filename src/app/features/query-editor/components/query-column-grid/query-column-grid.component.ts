import { DOCUMENT } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  EventEmitter,
  Input,
  Output,
  inject,
  signal,
} from '@angular/core';
import { SortDirection } from '../../models/report-definition.model';
import { QueryEditorStore } from '../../services/query-editor-store.service';

const sortDirections: readonly SortDirection[] = ['none', 'asc', 'desc'];
const minQueryGridHeight = 96;
const maxQueryGridHeight = 420;
const defaultQueryGridHeight = 132;
const resizeKeyboardStep = 24;

@Component({
  selector: 'app-query-column-grid',
  templateUrl: './query-column-grid.component.html',
  styleUrl: './query-column-grid.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class QueryColumnGridComponent {
  private readonly document = inject(DOCUMENT);
  private readonly destroyRef = inject(DestroyRef);
  @Output() readonly gridHeightChange = new EventEmitter<number>();

  @Input()
  set gridHeight(height: number) {
    this.queryGridHeight.set(clamp(height, minQueryGridHeight, maxQueryGridHeight));
  }

  protected readonly store = inject(QueryEditorStore);
  protected readonly sortDirections = sortDirections;
  protected readonly minQueryGridHeight = minQueryGridHeight;
  protected readonly maxQueryGridHeight = maxQueryGridHeight;
  protected readonly queryGridHeight = signal(defaultQueryGridHeight);
  protected readonly isColumnGridResizing = signal(false);

  private resizeStartY = 0;
  private resizeStartHeight = this.queryGridHeight();
  private mouseMoveListener: ((event: MouseEvent) => void) | null = null;
  private mouseUpListener: (() => void) | null = null;

  constructor() {
    this.destroyRef.onDestroy(() => this.stopColumnGridMouseResize());
  }

  protected startColumnGridMouseResize(event: MouseEvent): void {
    event.preventDefault();
    this.isColumnGridResizing.set(true);
    this.resizeStartY = event.clientY;
    this.resizeStartHeight = this.queryGridHeight();
    this.mouseMoveListener = (moveEvent) => this.resizeColumnGridWithMouse(moveEvent);
    this.mouseUpListener = () => this.stopColumnGridMouseResize();
    this.document.addEventListener('mousemove', this.mouseMoveListener);
    this.document.addEventListener('mouseup', this.mouseUpListener, { once: true });
  }

  protected adjustColumnGridHeight(event: KeyboardEvent): void {
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      this.setQueryGridHeight(this.queryGridHeight() + resizeKeyboardStep);
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      this.setQueryGridHeight(this.queryGridHeight() - resizeKeyboardStep);
    } else if (event.key === 'Home') {
      event.preventDefault();
      this.setQueryGridHeight(minQueryGridHeight);
    } else if (event.key === 'End') {
      event.preventDefault();
      this.setQueryGridHeight(maxQueryGridHeight);
    }
  }

  protected updateColumnAlias(columnId: string, event: Event): void {
    this.store.updateColumnAlias(columnId, readControlValue(event));
  }

  protected toggleColumnVisibility(columnId: string, event: Event): void {
    this.store.toggleColumnVisibility(columnId, readCheckedValue(event));
  }

  protected updateColumnSort(columnId: string, event: Event): void {
    this.store.updateColumnSort(columnId, readControlValue(event) as SortDirection);
  }

  protected updateColumnGroupBy(columnId: string, event: Event): void {
    this.store.updateColumnGroupBy(columnId, readCheckedValue(event));
  }

  protected updateColumnCriteria(columnId: string, event: Event): void {
    this.store.updateColumnCriteria(columnId, readControlValue(event));
  }

  protected updateColumnOrCriteria(columnId: string, index: number, event: Event): void {
    this.store.updateColumnOrCriteria(columnId, index, readControlValue(event));
  }

  protected isColumnActive(fieldId: string): boolean {
    const selection = this.store.canvasSelection();

    return selection.kind === 'field' && selection.fieldId === fieldId;
  }

  protected selectColumnField(fieldId: string, event?: Event): void {
    event?.stopPropagation();
    this.store.selectCanvasField(fieldId);
  }

  protected moveColumn(columnId: string, direction: -1 | 1, event?: Event): void {
    event?.stopPropagation();
    this.store.moveColumn(columnId, direction);
  }

  protected removeColumn(columnId: string, event?: Event): void {
    event?.stopPropagation();
    this.store.removeColumn(columnId);
  }

  protected handleColumnRowKeydown(columnId: string, fieldId: string, event: KeyboardEvent): void {
    if (isEditableTarget(event.target)) {
      return;
    }

    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      this.selectColumnField(fieldId, event);
      return;
    }

    if ((event.metaKey || event.ctrlKey) && event.key === 'ArrowUp') {
      event.preventDefault();
      this.moveColumn(columnId, -1, event);
      return;
    }

    if ((event.metaKey || event.ctrlKey) && event.key === 'ArrowDown') {
      event.preventDefault();
      this.moveColumn(columnId, 1, event);
      return;
    }

    if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault();
      this.removeColumn(columnId, event);
    }
  }

  private resizeColumnGridWithMouse(event: MouseEvent): void {
    if (!this.isColumnGridResizing()) {
      return;
    }

    const deltaY = event.clientY - this.resizeStartY;
    this.setQueryGridHeight(this.resizeStartHeight - deltaY);
  }

  private stopColumnGridMouseResize(): void {
    this.isColumnGridResizing.set(false);

    if (this.mouseMoveListener) {
      this.document.removeEventListener('mousemove', this.mouseMoveListener);
      this.mouseMoveListener = null;
    }

    if (this.mouseUpListener) {
      this.document.removeEventListener('mouseup', this.mouseUpListener);
      this.mouseUpListener = null;
    }
  }

  private setQueryGridHeight(height: number): void {
    const nextHeight = clamp(height, minQueryGridHeight, maxQueryGridHeight);
    this.queryGridHeight.set(nextHeight);
    this.gridHeightChange.emit(nextHeight);
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
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

function isEditableTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    target.closest('input, select, textarea, button, label') !== null
  );
}
