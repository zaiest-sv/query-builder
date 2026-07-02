import { DOCUMENT } from '@angular/common';
import { ChangeDetectionStrategy, Component, DestroyRef, inject, signal } from '@angular/core';
import { writeTableDragData } from '../../models/query-editor-drag-drop.model';
import { QueryEditorStore } from '../../services/query-editor-store.service';

interface TablePointerDragState {
  readonly tableId: string;
  readonly label: string;
  readonly startX: number;
  readonly startY: number;
  readonly dragging: boolean;
}

interface TableDragGhost {
  readonly tableId: string;
  readonly label: string;
  readonly x: number;
  readonly y: number;
}

const pointerDragThreshold = 6;

@Component({
  selector: 'app-datasource-panel',
  templateUrl: './datasource-panel.component.html',
  styleUrl: './datasource-panel.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    role: 'complementary',
    'aria-label': 'Datasource',
  },
})
export class DatasourcePanelComponent {
  private readonly document = inject(DOCUMENT);
  private readonly destroyRef = inject(DestroyRef);
  protected readonly store = inject(QueryEditorStore);
  protected readonly draggedTableId = signal<string | null>(null);
  protected readonly tableDragGhost = signal<TableDragGhost | null>(null);
  private readonly collapsedTableIds = signal<ReadonlySet<string>>(new Set());
  private readonly expandedTableIds = signal<ReadonlySet<string>>(new Set());
  protected readonly activeTableMenuId = signal<string | null>(null);

  private tablePointerDragState: TablePointerDragState | null = null;
  private mouseMoveListener: ((event: MouseEvent) => void) | null = null;
  private mouseUpListener: ((event: MouseEvent) => void) | null = null;

  constructor() {
    this.destroyRef.onDestroy(() => this.stopTablePointerDrag());
  }

  protected setSearchTerm(event: Event): void {
    this.store.setSearchTerm(readControlValue(event));
  }

  protected isTableExpanded(tableId: string): boolean {
    if (this.store.searchTerm()) {
      return true;
    }

    if (this.collapsedTableIds().has(tableId)) {
      return false;
    }

    return this.expandedTableIds().has(tableId) || this.store.selectedTableId() === tableId;
  }

  protected toggleTableExpanded(tableId: string, event: MouseEvent): void {
    event.stopPropagation();
    this.activeTableMenuId.set(null);

    if (this.isTableExpanded(tableId)) {
      this.collapsedTableIds.update((tableIds) => nextSetWith(tableIds, tableId));
      this.expandedTableIds.update((tableIds) => nextSetWithout(tableIds, tableId));
      return;
    }

    this.expandTable(tableId);
  }

  protected useTable(tableId: string): void {
    this.activeTableMenuId.set(null);
    this.expandTable(tableId);
    this.store.selectTable(tableId);
  }

  protected isSourceTable(tableId: string): boolean {
    return this.store.report().query.sourceTableIds.includes(tableId);
  }

  protected isTableMenuOpen(tableId: string): boolean {
    return this.activeTableMenuId() === tableId;
  }

  protected toggleTableMenu(tableId: string, event: MouseEvent): void {
    event.stopPropagation();
    this.activeTableMenuId.update((activeTableId) => (activeTableId === tableId ? null : tableId));
  }

  protected addAllFields(tableId: string): void {
    this.activeTableMenuId.set(null);
    this.expandTable(tableId);
    this.store.addColumnsForTable(tableId);
  }

  protected removeSourceTable(tableId: string): void {
    this.activeTableMenuId.set(null);
    this.store.removeSourceTable(tableId);
  }

  protected startTableDrag(tableId: string, event: DragEvent): void {
    if (!event.dataTransfer) {
      return;
    }

    this.activeTableMenuId.set(null);
    this.draggedTableId.set(tableId);
    writeTableDragData(event.dataTransfer, tableId);
    event.dataTransfer.dropEffect = 'copy';
  }

  protected finishTableDrag(): void {
    this.draggedTableId.set(null);
  }

  protected startTablePointerDrag(tableId: string, label: string, event: MouseEvent): void {
    if (event.button !== 0 || isActionTarget(event.target)) {
      return;
    }

    this.activeTableMenuId.set(null);
    this.stopTablePointerDrag();
    this.tablePointerDragState = {
      tableId,
      label,
      startX: event.clientX,
      startY: event.clientY,
      dragging: false,
    };
    this.mouseMoveListener = (moveEvent) => this.moveTablePointerDrag(moveEvent);
    this.mouseUpListener = (upEvent) => this.completeTablePointerDrag(upEvent);
    this.document.addEventListener('mousemove', this.mouseMoveListener);
    this.document.addEventListener('mouseup', this.mouseUpListener, { once: true });
  }

  private moveTablePointerDrag(event: MouseEvent): void {
    const state = this.tablePointerDragState;

    if (!state) {
      return;
    }

    const distance = Math.hypot(event.clientX - state.startX, event.clientY - state.startY);

    if (!state.dragging && distance < pointerDragThreshold) {
      return;
    }

    event.preventDefault();
    this.tablePointerDragState = { ...state, dragging: true };
    this.draggedTableId.set(state.tableId);
    this.tableDragGhost.set({
      tableId: state.tableId,
      label: state.label,
      x: event.clientX + 12,
      y: event.clientY + 12,
    });
  }

  private completeTablePointerDrag(event: MouseEvent): void {
    const state = this.tablePointerDragState;

    if (state?.dragging) {
      event.preventDefault();
      this.dropTableOnCanvas(state.tableId, event.clientX, event.clientY);
    }

    this.stopTablePointerDrag();
  }

  private dropTableOnCanvas(tableId: string, clientX: number, clientY: number): void {
    const element = this.document.elementFromPoint(clientX, clientY);
    const canvas = element?.closest<HTMLElement>('.query-canvas');

    if (!canvas) {
      return;
    }

    const canvasRect = canvas.getBoundingClientRect();

    this.store.addSourceTableAtPosition(tableId, {
      x: clientX - canvasRect.left + canvas.scrollLeft - 24,
      y: clientY - canvasRect.top + canvas.scrollTop - 24,
    });
  }

  private stopTablePointerDrag(): void {
    this.tablePointerDragState = null;
    this.draggedTableId.set(null);
    this.tableDragGhost.set(null);

    if (this.mouseMoveListener) {
      this.document.removeEventListener('mousemove', this.mouseMoveListener);
      this.mouseMoveListener = null;
    }

    if (this.mouseUpListener) {
      this.document.removeEventListener('mouseup', this.mouseUpListener);
      this.mouseUpListener = null;
    }
  }

  private expandTable(tableId: string): void {
    this.collapsedTableIds.update((tableIds) => nextSetWithout(tableIds, tableId));
    this.expandedTableIds.update((tableIds) => nextSetWith(tableIds, tableId));
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

function isActionTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && target.closest('.tree-action') !== null;
}

function nextSetWith(source: ReadonlySet<string>, value: string): ReadonlySet<string> {
  const next = new Set(source);
  next.add(value);

  return next;
}

function nextSetWithout(source: ReadonlySet<string>, value: string): ReadonlySet<string> {
  const next = new Set(source);
  next.delete(value);

  return next;
}
