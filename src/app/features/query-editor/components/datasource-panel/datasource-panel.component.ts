import { DOCUMENT } from '@angular/common';
import { ChangeDetectionStrategy, Component, DestroyRef, inject, signal } from '@angular/core';
import { DataSourceField, QueryColumn, QuerySubquery } from '../../models/report-definition.model';
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

type DatasourcePanelTab = 'datasource' | 'subquery';

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
  protected readonly activePanelTab = signal<DatasourcePanelTab>('datasource');
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

  protected setActivePanelTab(tab: DatasourcePanelTab): void {
    this.activePanelTab.set(tab);
    this.activeTableMenuId.set(null);
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
    if (!this.canUseDatasourceTable(tableId)) {
      return;
    }

    this.activeTableMenuId.set(null);
    this.expandTable(tableId);
    this.store.selectTable(tableId);
  }

  protected canUseDatasourceTable(tableId: string): boolean {
    return this.store.canUseTableAsSource(tableId);
  }

  protected isSourceTable(tableId: string): boolean {
    return this.store.activeQuery().sourceTableIds.includes(tableId);
  }

  protected isTableMenuOpen(tableId: string): boolean {
    return this.activeTableMenuId() === tableId;
  }

  protected toggleTableMenu(tableId: string, event: MouseEvent): void {
    event.stopPropagation();
    this.activeTableMenuId.update((activeTableId) => (activeTableId === tableId ? null : tableId));
  }

  protected addAllFields(tableId: string): void {
    if (!this.canUseDatasourceTable(tableId)) {
      return;
    }

    this.activeTableMenuId.set(null);
    this.expandTable(tableId);
    this.store.addColumnsForTable(tableId);
  }

  protected removeSourceTable(tableId: string): void {
    this.activeTableMenuId.set(null);
    this.store.removeSourceTable(tableId);
  }

  protected useSubqueryAsSource(subqueryId: string): void {
    if (!this.canUseSubqueryAsSource(subqueryId)) {
      return;
    }

    this.store.selectTable(this.store.subqueryTableId(subqueryId));
  }

  protected updateSubqueryName(subqueryId: string, event: Event): void {
    this.store.updateSubqueryName(subqueryId, readControlValue(event));
  }

  protected updateSubqueryAlias(subqueryId: string, event: Event): void {
    this.store.updateSubqueryAlias(subqueryId, readControlValue(event));
  }

  protected canUseSubqueryAsSource(subqueryId: string): boolean {
    const subquery = this.store
      .report()
      .subqueries.find((currentSubquery) => currentSubquery.id === subqueryId);

    return Boolean(
      subquery &&
      this.subqueryIssues(subquery).length === 0 &&
      this.store.canUseTableAsSource(this.store.subqueryTableId(subqueryId)),
    );
  }

  protected subquerySourceCount(subquery: QuerySubquery): number {
    return subquery.query.sourceTableIds.length;
  }

  protected outputColumnsForSubquery(subquery: QuerySubquery): readonly QueryColumn[] {
    return subquery.query.columns.filter((column) => column.visible);
  }

  protected outputFieldForColumn(column: QueryColumn): DataSourceField | null {
    return this.store.fieldLookup().get(column.fieldId) ?? null;
  }

  protected subqueryIssues(subquery: QuerySubquery): readonly string[] {
    const issues: string[] = [];
    const outputColumns = this.outputColumnsForSubquery(subquery);

    if (subquery.query.sourceTableIds.length === 0) {
      issues.push('Add at least one source.');
    }

    if (outputColumns.length === 0) {
      issues.push('Select at least one visible output column.');
    }

    if (this.store.hasSubqueryDependencyCycle(subquery.id)) {
      issues.push('Circular subquery dependency.');
    }

    for (const tableId of subquery.query.sourceTableIds) {
      if (tableId === this.store.subqueryTableId(subquery.id)) {
        issues.push('A subquery cannot use itself.');
      } else if (!this.store.tableLookup().has(tableId)) {
        issues.push(`Missing source: ${tableId}.`);
      }
    }

    for (const column of subquery.query.columns) {
      const field = this.store.fieldLookup().get(column.fieldId);

      if (!field) {
        issues.push(`Missing field for ${column.alias}.`);
      } else if (!subquery.query.sourceTableIds.includes(field.tableId)) {
        issues.push(`${column.alias} is not from a selected source.`);
      }
    }

    return issues;
  }

  protected startTableDrag(tableId: string, event: DragEvent): void {
    if (!event.dataTransfer || !this.canUseDatasourceTable(tableId)) {
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
    if (
      event.button !== 0 ||
      isActionTarget(event.target) ||
      !this.canUseDatasourceTable(tableId)
    ) {
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
