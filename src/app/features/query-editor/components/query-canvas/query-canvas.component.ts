import { DOCUMENT } from '@angular/common';
import {
  AfterViewInit,
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  QueryList,
  ViewChild,
  ViewChildren,
  WritableSignal,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import {
  DataSourceField,
  DataSourceTable,
  QueryJoinType,
} from '../../models/report-definition.model';
import {
  QUERY_TABLE_DRAG_TYPE,
  readTableDragData,
} from '../../models/query-editor-drag-drop.model';
import {
  CanvasJoin,
  CanvasJoinStatus,
  JoinDropMode,
  QueryEditorStore,
} from '../../services/query-editor-store.service';

const joinTypes: readonly QueryJoinType[] = ['left', 'inner', 'right', 'full', 'cross'];
const canvasTableColumnStep = 348;
const canvasTableRowStep = 264;
const canvasTableStagger = [0, 28, 58] as const;
const joinDragThreshold = 6;

type JoinAnchorSide = 'left' | 'right';

interface JoinPath {
  readonly key: string;
  readonly joinId: string;
  readonly conditionId: string;
  readonly fromFieldId: string;
  readonly toFieldId: string;
  readonly startSide: JoinAnchorSide;
  readonly endSide: JoinAnchorSide;
  readonly status: CanvasJoinStatus;
  readonly path: string;
  readonly startX: number;
  readonly startY: number;
  readonly endX: number;
  readonly endY: number;
}

interface JoinDragPreview {
  readonly mode: JoinDropMode;
  readonly path: string;
  readonly endX: number;
  readonly endY: number;
}

interface JoinDropHint {
  readonly mode: JoinDropMode;
  readonly x: number;
  readonly y: number;
  readonly message: string;
}

interface CanvasTablePosition {
  readonly x: number;
  readonly y: number;
}

interface TableDragState {
  readonly tableId: string;
  readonly startPointerX: number;
  readonly startPointerY: number;
  readonly startX: number;
  readonly startY: number;
}

interface JoinPointerDragState {
  readonly fieldId: string;
  readonly startPointerX: number;
  readonly startPointerY: number;
  readonly dragging: boolean;
}

@Component({
  selector: 'app-query-canvas',
  templateUrl: './query-canvas.component.html',
  styleUrl: './query-canvas.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class QueryCanvasComponent implements AfterViewInit {
  @ViewChild('canvasViewport') private canvasViewport?: ElementRef<HTMLElement>;
  @ViewChildren('fieldRow') private fieldRows?: QueryList<ElementRef<HTMLElement>>;

  private readonly document = inject(DOCUMENT);
  private readonly destroyRef = inject(DestroyRef);
  protected readonly store = inject(QueryEditorStore);
  protected readonly joinTypes = joinTypes;
  protected readonly activeTableMenuId = signal<string | null>(null);
  protected readonly hiddenUnusedTableIds = signal<ReadonlySet<string>>(new Set());
  protected readonly sortedTableIds = signal<ReadonlySet<string>>(new Set());
  protected readonly fieldFilterTerms = signal<Readonly<Record<string, string>>>({});
  protected readonly activeTableDragId = signal<string | null>(null);
  protected readonly isTableDropTarget = signal(false);
  protected readonly draggedJoinFieldId = signal<string | null>(null);
  protected readonly joinDragTargetFieldId = signal<string | null>(null);
  protected readonly joinDragPreview = signal<JoinDragPreview | null>(null);
  protected readonly joinDropHint = signal<JoinDropHint | null>(null);
  protected readonly joinPaths = signal<readonly JoinPath[]>([]);
  protected readonly fieldJoinSides = computed(() => {
    const sides = new Map<string, Set<JoinAnchorSide>>();

    for (const path of this.joinPaths()) {
      addFieldJoinSide(sides, path.fromFieldId, path.startSide);
      addFieldJoinSide(sides, path.toFieldId, path.endSide);
    }

    return sides;
  });
  protected readonly joinLayerWidth = signal(980);
  protected readonly joinLayerHeight = signal(320);
  protected readonly joinLayerViewBox = computed(
    () => `0 0 ${this.joinLayerWidth()} ${this.joinLayerHeight()}`,
  );

  private tableDragMoveListener: ((event: PointerEvent) => void) | null = null;
  private tableDragUpListener: (() => void) | null = null;
  private tableDragState: TableDragState | null = null;
  private pointerMoveListener: ((event: PointerEvent) => void) | null = null;
  private pointerUpListener: ((event: PointerEvent) => void) | null = null;
  private joinPointerDragState: JoinPointerDragState | null = null;
  private suppressNextFieldClick = false;
  private joinPathFrame = 0;

  constructor() {
    this.destroyRef.onDestroy(() => this.stopJoinPointerDrag());
    this.destroyRef.onDestroy(() => this.stopTablePointerDrag());
    this.destroyRef.onDestroy(() => {
      const view = this.document.defaultView;

      if (view && this.joinPathFrame !== 0) {
        view.cancelAnimationFrame(this.joinPathFrame);
      }
    });
    effect(() => {
      this.store.canvasJoins();
      this.store.selectedTables();
      this.hiddenUnusedTableIds();
      this.sortedTableIds();
      this.fieldFilterTerms();
      this.store.canvasTablePositions();
      this.scheduleJoinPathRefresh();
    });
  }

  ngAfterViewInit(): void {
    const subscription = this.fieldRows?.changes.subscribe(() => this.scheduleJoinPathRefresh());
    this.destroyRef.onDestroy(() => subscription?.unsubscribe());
    this.scheduleJoinPathRefresh();
  }

  protected selectCanvasTable(tableId: string): void {
    this.store.selectCanvasTable(tableId);
  }

  protected toggleTableMenu(tableId: string): void {
    this.activeTableMenuId.update((currentTableId) =>
      currentTableId === tableId ? null : tableId,
    );
    this.selectCanvasTable(tableId);
  }

  protected openTableMenu(tableId: string, event: MouseEvent): void {
    event.stopPropagation();
    this.toggleTableMenu(tableId);
  }

  protected removeCanvasTable(tableId: string, event: MouseEvent): void {
    event.stopPropagation();
    this.store.removeSourceTable(tableId);
  }

  protected tablePositionX(tableId: string, index: number): number {
    return this.tablePosition(tableId, index).x;
  }

  protected tablePositionY(tableId: string, index: number): number {
    return this.tablePosition(tableId, index).y;
  }

  protected startTablePointerDrag(tableId: string, index: number, event: PointerEvent): void {
    if (isInteractiveTarget(event.target)) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    const position = this.tablePosition(tableId, index);
    this.store.selectCanvasTable(tableId);
    this.activeTableMenuId.set(null);
    this.activeTableDragId.set(tableId);
    this.tableDragState = {
      tableId,
      startPointerX: event.clientX,
      startPointerY: event.clientY,
      startX: position.x,
      startY: position.y,
    };
    this.tableDragMoveListener = (moveEvent) => this.moveTableWithPointer(moveEvent);
    this.tableDragUpListener = () => this.stopTablePointerDrag();
    this.document.addEventListener('pointermove', this.tableDragMoveListener);
    this.document.addEventListener('pointerup', this.tableDragUpListener, { once: true });
  }

  protected isTableMenuOpen(tableId: string): boolean {
    return this.activeTableMenuId() === tableId;
  }

  protected toggleHideUnusedFields(tableId: string): void {
    this.toggleTableSet(this.hiddenUnusedTableIds, tableId);
  }

  protected toggleSortFields(tableId: string): void {
    this.toggleTableSet(this.sortedTableIds, tableId);
  }

  protected visibleFieldsForTable(table: DataSourceTable): readonly DataSourceField[] {
    let fields = [...table.fields];

    if (this.hiddenUnusedTableIds().has(table.id)) {
      fields = fields.filter(
        (field) =>
          this.store.selectedFieldIds().has(field.id) || this.store.joinedFieldIds().has(field.id),
      );
    }

    const filterTerm = this.fieldFilterTerm(table.id).trim().toLowerCase();

    if (filterTerm) {
      fields = fields.filter(
        (field) =>
          field.name.toLowerCase().includes(filterTerm) ||
          field.label.toLowerCase().includes(filterTerm) ||
          field.type.toLowerCase().includes(filterTerm),
      );
    }

    if (this.sortedTableIds().has(table.id)) {
      fields.sort((first, second) => first.label.localeCompare(second.label));
    }

    return fields;
  }

  protected fieldFilterTerm(tableId: string): string {
    return this.fieldFilterTerms()[tableId] ?? '';
  }

  protected setFieldFilterTerm(tableId: string, event: Event): void {
    const value = readControlValue(event);

    this.fieldFilterTerms.update((terms) => {
      if (!value) {
        const nextTerms = { ...terms };
        delete nextTerms[tableId];

        return nextTerms;
      }

      return { ...terms, [tableId]: value };
    });
  }

  protected isFieldSelected(fieldId: string): boolean {
    return this.store.selectedFieldIds().has(fieldId);
  }

  protected isFieldJoined(fieldId: string): boolean {
    return this.store.joinedFieldIds().has(fieldId);
  }

  protected isFieldJoinedLeft(fieldId: string): boolean {
    return this.fieldJoinSides().get(fieldId)?.has('left') ?? false;
  }

  protected isFieldJoinedRight(fieldId: string): boolean {
    return this.fieldJoinSides().get(fieldId)?.has('right') ?? false;
  }

  protected isCanvasTableSelected(tableId: string): boolean {
    const selection = this.store.canvasSelection();

    return selection.kind === 'table' && selection.tableId === tableId;
  }

  protected isFieldActive(fieldId: string): boolean {
    const selection = this.store.canvasSelection();

    return selection.kind === 'field' && selection.fieldId === fieldId;
  }

  protected isJoinActive(joinId: string): boolean {
    const selection = this.store.canvasSelection();

    return selection.kind === 'join' && selection.joinId === joinId;
  }

  protected joinIssueSummary(join: CanvasJoin): string {
    return join.issues.map((issue) => issue.message).join(' ');
  }

  protected toggleCanvasField(fieldId: string, event: Event): void {
    event.stopPropagation();

    if (readCheckedValue(event)) {
      this.store.addColumn(fieldId);
    } else {
      this.store.removeColumnByFieldId(fieldId);
    }
  }

  protected selectCanvasField(fieldId: string, event: MouseEvent): void {
    if (this.suppressNextFieldClick) {
      this.suppressNextFieldClick = false;
      event.stopPropagation();
      return;
    }

    if (isInteractiveTarget(event.target)) {
      return;
    }

    event.stopPropagation();
    this.store.selectCanvasField(fieldId);
    this.activeTableMenuId.set(null);
  }

  protected checkAllFields(tableId: string): void {
    this.store.addColumnsForTable(tableId);
    this.activeTableMenuId.set(null);
  }

  protected uncheckAllFields(tableId: string): void {
    this.store.removeColumnsForTable(tableId);
    this.activeTableMenuId.set(null);
  }

  protected openTableProperties(tableId: string): void {
    this.selectCanvasTable(tableId);
    this.activeTableMenuId.set(null);
  }

  protected startJoinPointerDrag(fieldId: string, event: PointerEvent): void {
    if (isInteractiveTarget(event.target)) {
      return;
    }

    event.stopPropagation();
    this.store.selectCanvasField(fieldId);
    this.activeTableMenuId.set(null);
    this.stopJoinPointerDrag();
    this.joinPointerDragState = {
      fieldId,
      startPointerX: event.clientX,
      startPointerY: event.clientY,
      dragging: false,
    };
    this.pointerMoveListener = (moveEvent) => this.moveJoinPointerDrag(moveEvent);
    this.pointerUpListener = (upEvent) => this.completeJoinPointerDrag(upEvent);
    this.document.addEventListener('pointermove', this.pointerMoveListener);
    this.document.addEventListener('pointerup', this.pointerUpListener, { once: true });
  }

  protected canDropJoinOn(fieldId: string): boolean {
    const sourceFieldId = this.draggedJoinFieldId();

    return sourceFieldId ? this.store.assessJoinDrop(sourceFieldId, fieldId).canDrop : false;
  }

  protected isJoinDropBlocked(fieldId: string): boolean {
    const sourceFieldId = this.draggedJoinFieldId();

    return (
      this.joinDragTargetFieldId() === fieldId &&
      sourceFieldId !== null &&
      !this.store.assessJoinDrop(sourceFieldId, fieldId).canDrop
    );
  }

  protected joinsForTable(tableId: string): readonly CanvasJoin[] {
    return this.store
      .canvasJoins()
      .filter((join) => join.fromTableId === tableId || join.toTableId === tableId);
  }

  protected selectJoin(joinId: string, event: MouseEvent): void {
    event.stopPropagation();
    this.store.selectCanvasJoin(joinId);
    this.activeTableMenuId.set(null);
  }

  protected updateJoinType(joinId: string, event: Event): void {
    event.stopPropagation();
    this.store.selectCanvasJoin(joinId);
    this.store.updateJoinType(joinId, readControlValue(event) as QueryJoinType);
    this.scheduleJoinPathRefresh();
  }

  protected removeJoin(joinId: string, event: MouseEvent): void {
    event.stopPropagation();
    this.store.removeJoin(joinId);
    this.scheduleJoinPathRefresh();
  }

  protected allowDatasourceTableDrop(event: DragEvent): void {
    if (!event.dataTransfer || !hasDatasourceTableDragData(event.dataTransfer)) {
      return;
    }

    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
    this.isTableDropTarget.set(true);
  }

  protected leaveDatasourceTableDrop(event: DragEvent): void {
    if (event.currentTarget !== event.target) {
      return;
    }

    this.isTableDropTarget.set(false);
  }

  protected dropDatasourceTable(event: DragEvent): void {
    const canvas = this.canvasViewport?.nativeElement;
    const payload = event.dataTransfer ? readTableDragData(event.dataTransfer) : null;

    if (!canvas || !payload) {
      this.isTableDropTarget.set(false);
      return;
    }

    event.preventDefault();
    const canvasRect = canvas.getBoundingClientRect();

    this.store.addSourceTableAtPosition(payload.tableId, {
      x: event.clientX - canvasRect.left + canvas.scrollLeft - 24,
      y: event.clientY - canvasRect.top + canvas.scrollTop - 24,
    });
    this.isTableDropTarget.set(false);
    this.scheduleJoinPathRefresh();
  }

  private tablePosition(tableId: string, index: number): CanvasTablePosition {
    return this.store.canvasTablePositions().get(tableId) ?? defaultTablePosition(index);
  }

  private moveTableWithPointer(event: PointerEvent): void {
    if (!this.tableDragState) {
      return;
    }

    event.preventDefault();

    const nextPosition = {
      x: Math.max(
        0,
        this.tableDragState.startX + event.clientX - this.tableDragState.startPointerX,
      ),
      y: Math.max(
        0,
        this.tableDragState.startY + event.clientY - this.tableDragState.startPointerY,
      ),
    };
    const { tableId } = this.tableDragState;

    this.store.updateCanvasTablePosition(tableId, nextPosition);
    this.scheduleJoinPathRefresh();
  }

  private stopTablePointerDrag(): void {
    this.activeTableDragId.set(null);
    this.tableDragState = null;

    if (this.tableDragMoveListener) {
      this.document.removeEventListener('pointermove', this.tableDragMoveListener);
      this.tableDragMoveListener = null;
    }

    if (this.tableDragUpListener) {
      this.document.removeEventListener('pointerup', this.tableDragUpListener);
      this.tableDragUpListener = null;
    }

    this.scheduleJoinPathRefresh();
  }

  private scheduleJoinPathRefresh(): void {
    const view = this.document.defaultView;

    if (!view || this.joinPathFrame !== 0) {
      return;
    }

    this.joinPathFrame = view.requestAnimationFrame(() => {
      this.joinPathFrame = 0;
      this.refreshJoinPaths();
    });
  }

  private moveJoinPointerDrag(event: PointerEvent): void {
    const state = this.joinPointerDragState;

    if (!state) {
      return;
    }

    const distance = Math.hypot(
      event.clientX - state.startPointerX,
      event.clientY - state.startPointerY,
    );

    if (!state.dragging && distance < joinDragThreshold) {
      return;
    }

    event.preventDefault();

    if (!state.dragging) {
      this.joinPointerDragState = { ...state, dragging: true };
      this.draggedJoinFieldId.set(state.fieldId);
    }

    this.updateJoinDragPreview(event);
  }

  private updateJoinDragPreview(event: PointerEvent): void {
    const sourceFieldId = this.draggedJoinFieldId();
    const canvas = this.canvasViewport?.nativeElement;

    if (!sourceFieldId || !canvas) {
      this.joinDragPreview.set(null);
      this.joinDropHint.set(null);
      return;
    }

    const targetFieldId = this.fieldIdAtPoint(event.clientX, event.clientY);
    const assessment = targetFieldId
      ? this.store.assessJoinDrop(sourceFieldId, targetFieldId)
      : {
          mode: 'invalid' as const,
          canDrop: false,
          message: 'Drop on a field from another datasource.',
        };
    const preview = createPointerJoinPreview(
      sourceFieldId,
      event.clientX,
      event.clientY,
      canvas,
      assessment.mode,
    );

    this.joinDragTargetFieldId.set(targetFieldId || null);
    this.joinDragPreview.set(preview);
    this.joinDropHint.set(
      preview
        ? {
            mode: assessment.mode,
            x: preview.endX + 12,
            y: preview.endY + 12,
            message: assessment.message,
          }
        : null,
    );
  }

  private completeJoinPointerDrag(event: PointerEvent): void {
    const state = this.joinPointerDragState;

    if (!state?.dragging) {
      this.stopJoinPointerDrag();
      return;
    }

    event.preventDefault();
    const sourceFieldId = this.draggedJoinFieldId();
    const targetFieldId = this.fieldIdAtPoint(event.clientX, event.clientY);
    const assessment =
      sourceFieldId && targetFieldId
        ? this.store.assessJoinDrop(sourceFieldId, targetFieldId)
        : null;

    if (sourceFieldId && targetFieldId && assessment?.canDrop) {
      this.store.addJoinOrCondition(sourceFieldId, targetFieldId);
      this.scheduleJoinPathRefresh();
    }

    this.suppressNextFieldClickOnce();
    this.stopJoinPointerDrag();
  }

  private stopJoinPointerDrag(): void {
    this.joinPointerDragState = null;
    this.draggedJoinFieldId.set(null);
    this.joinDragTargetFieldId.set(null);
    this.joinDragPreview.set(null);
    this.joinDropHint.set(null);

    if (this.pointerMoveListener) {
      this.document.removeEventListener('pointermove', this.pointerMoveListener);
      this.pointerMoveListener = null;
    }

    if (this.pointerUpListener) {
      this.document.removeEventListener('pointerup', this.pointerUpListener);
      this.pointerUpListener = null;
    }
  }

  private suppressNextFieldClickOnce(): void {
    this.suppressNextFieldClick = true;
    this.document.defaultView?.setTimeout(() => {
      this.suppressNextFieldClick = false;
    }, 0);
  }

  private fieldIdAtPoint(clientX: number, clientY: number): string {
    const element = this.document.elementFromPoint(clientX, clientY);
    const row = element?.closest<HTMLElement>('[data-field-id]');

    return row?.dataset['fieldId'] ?? '';
  }

  private refreshJoinPaths(): void {
    const canvas = this.canvasViewport?.nativeElement;

    if (!canvas) {
      return;
    }

    const canvasRect = canvas.getBoundingClientRect();
    const fieldRows = new Map<string, HTMLElement>();

    for (const row of Array.from(canvas.querySelectorAll<HTMLElement>('[data-field-id]'))) {
      const fieldId = row.dataset['fieldId'];

      if (fieldId) {
        fieldRows.set(fieldId, row);
      }
    }

    this.joinLayerWidth.set(Math.max(canvas.scrollWidth, canvas.clientWidth));
    this.joinLayerHeight.set(Math.max(canvas.scrollHeight, canvas.clientHeight));
    this.joinPaths.set(
      this.store
        .canvasJoins()
        .flatMap((join) =>
          createJoinPaths(join, fieldRows, canvasRect, canvas.scrollLeft, canvas.scrollTop),
        )
        .filter((path): path is JoinPath => path !== null),
    );
  }

  private toggleTableSet(setSignal: WritableSignal<ReadonlySet<string>>, tableId: string): void {
    setSignal.update((currentSet) => {
      const nextSet = new Set(currentSet);

      if (nextSet.has(tableId)) {
        nextSet.delete(tableId);
      } else {
        nextSet.add(tableId);
      }

      return nextSet;
    });
  }
}

function createJoinPaths(
  join: CanvasJoin,
  fieldRows: ReadonlyMap<string, HTMLElement>,
  canvasRect: DOMRect,
  scrollLeft: number,
  scrollTop: number,
): readonly JoinPath[] {
  return join.conditions
    .map((condition, index) =>
      createJoinPathForCondition(
        join,
        condition,
        index,
        fieldRows,
        canvasRect,
        scrollLeft,
        scrollTop,
      ),
    )
    .filter((path): path is JoinPath => path !== null);
}

function createJoinPathForCondition(
  join: CanvasJoin,
  condition: CanvasJoin['conditions'][number],
  conditionIndex: number,
  fieldRows: ReadonlyMap<string, HTMLElement>,
  canvasRect: DOMRect,
  scrollLeft: number,
  scrollTop: number,
): JoinPath | null {
  const fromRow = fieldRows.get(condition.fromFieldId);
  const toRow = fieldRows.get(condition.toFieldId);

  if (!fromRow || !toRow) {
    return null;
  }

  const fromRect = fromRow.getBoundingClientRect();
  const toRect = toRow.getBoundingClientRect();
  const fromCenterX = fromRect.left + fromRect.width / 2;
  const toCenterX = toRect.left + toRect.width / 2;
  const sourceIsLeft = fromCenterX <= toCenterX;
  const startSide: JoinAnchorSide = sourceIsLeft ? 'right' : 'left';
  const endSide: JoinAnchorSide = sourceIsLeft ? 'left' : 'right';
  const startX =
    (startSide === 'right' ? fromRect.right : fromRect.left) - canvasRect.left + scrollLeft;
  const endX = (endSide === 'left' ? toRect.left : toRect.right) - canvasRect.left + scrollLeft;
  const laneOffset = conditionIndex * 3;
  const startY = fromRect.top - canvasRect.top + scrollTop + fromRect.height / 2 + laneOffset;
  const endY = toRect.top - canvasRect.top + scrollTop + toRect.height / 2 + laneOffset;
  const status = condition.status === 'valid' ? join.status : condition.status;

  return {
    key: `${join.id}:${condition.id}`,
    joinId: join.id,
    conditionId: condition.id,
    fromFieldId: condition.fromFieldId,
    toFieldId: condition.toFieldId,
    startSide,
    endSide,
    status,
    path: createCurvePath(startX, startY, endX, endY),
    startX: round(startX),
    startY: round(startY),
    endX: round(endX),
    endY: round(endY),
  };
}

function addFieldJoinSide(
  sides: Map<string, Set<JoinAnchorSide>>,
  fieldId: string,
  side: JoinAnchorSide,
): void {
  const fieldSides = sides.get(fieldId) ?? new Set<JoinAnchorSide>();

  fieldSides.add(side);
  sides.set(fieldId, fieldSides);
}

function createPointerJoinPreview(
  sourceFieldId: string,
  clientX: number,
  clientY: number,
  canvas: HTMLElement,
  mode: JoinDropMode,
): JoinDragPreview | null {
  const sourceRow = Array.from(canvas.querySelectorAll<HTMLElement>('[data-field-id]')).find(
    (row) => row.dataset['fieldId'] === sourceFieldId,
  );

  if (!sourceRow) {
    return null;
  }

  const canvasRect = canvas.getBoundingClientRect();
  const sourceRect = sourceRow.getBoundingClientRect();
  const sourceCenterX = sourceRect.left + sourceRect.width / 2;
  const sourceIsLeft = sourceCenterX <= clientX;
  const startX =
    (sourceIsLeft ? sourceRect.right : sourceRect.left) - canvasRect.left + canvas.scrollLeft;
  const startY = sourceRect.top - canvasRect.top + canvas.scrollTop + sourceRect.height / 2;
  const endX = clientX - canvasRect.left + canvas.scrollLeft;
  const endY = clientY - canvasRect.top + canvas.scrollTop;

  return {
    mode,
    path: createCurvePath(startX, startY, endX, endY),
    endX: round(endX),
    endY: round(endY),
  };
}

function createCurvePath(startX: number, startY: number, endX: number, endY: number): string {
  const direction = endX >= startX ? 1 : -1;
  const bend = Math.max(56, Math.min(180, Math.abs(endX - startX) * 0.45));

  return `M ${round(startX)} ${round(startY)} C ${round(startX + bend * direction)} ${round(startY)}, ${round(endX - bend * direction)} ${round(endY)}, ${round(endX)} ${round(endY)}`;
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}

function defaultTablePosition(index: number): CanvasTablePosition {
  const column = index % 3;
  const row = Math.floor(index / 3);

  return {
    x: column * canvasTableColumnStep,
    y: row * canvasTableRowStep + canvasTableStagger[column],
  };
}

function isInteractiveTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    target.closest('input, button, select, textarea, label') !== null
  );
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

function hasDatasourceTableDragData(dataTransfer: DataTransfer): boolean {
  return Array.from(dataTransfer.types).includes(QUERY_TABLE_DRAG_TYPE);
}
