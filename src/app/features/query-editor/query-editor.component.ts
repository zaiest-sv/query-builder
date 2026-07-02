import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { AdvancedPanelComponent } from './components/advanced-panel/advanced-panel.component';
import { CrosstabPanelComponent } from './components/crosstab-panel/crosstab-panel.component';
import { DatasourcePanelComponent } from './components/datasource-panel/datasource-panel.component';
import { PreviewPanelComponent } from './components/preview-panel/preview-panel.component';
import { PromptedCriteriaPanelComponent } from './components/prompted-criteria-panel/prompted-criteria-panel.component';
import { QueryCanvasComponent } from './components/query-canvas/query-canvas.component';
import { QueryColumnGridComponent } from './components/query-column-grid/query-column-grid.component';
import { QueryPropertiesPanelComponent } from './components/query-properties-panel/query-properties-panel.component';
import { QuerySqlPanelComponent } from './components/query-sql-panel/query-sql-panel.component';
import { WorkspaceToolbarComponent } from './components/workspace-toolbar/workspace-toolbar.component';
import { QueryEditorStore } from './services/query-editor-store.service';

type EditorTab = 'query' | 'criteria' | 'preview' | 'crosstab' | 'advanced';

interface EditorTabItem {
  readonly id: EditorTab;
  readonly label: string;
}

const tabs: readonly EditorTabItem[] = [
  { id: 'query', label: 'Query Editor' },
  { id: 'criteria', label: 'Prompted Criteria' },
  { id: 'preview', label: 'Preview' },
  { id: 'crosstab', label: 'Crosstab' },
  { id: 'advanced', label: 'Advanced' },
];

const columnGridResizerHeight = 12;
const defaultColumnGridHeight = 132;
const minColumnGridHeight = 96;
const maxColumnGridHeight = 420;
const defaultDatasourcePanelWidth = 350;
const minDatasourcePanelWidth = 240;
const maxDatasourcePanelWidth = 560;
const defaultQuerySidePanelWidth = 430;
const minQuerySidePanelWidth = 320;
const maxQuerySidePanelWidth = 680;
const panelResizeStep = 24;
const layoutStorageKey = 'query-builder.editor-layout';

type HorizontalResizeTarget = 'datasource' | 'query-side';

interface EditorLayoutPreference {
  readonly datasourcePanelWidth: number;
  readonly querySidePanelWidth: number;
  readonly columnGridHeight: number;
}

@Component({
  selector: 'app-query-editor',
  imports: [
    AdvancedPanelComponent,
    CrosstabPanelComponent,
    DatasourcePanelComponent,
    PreviewPanelComponent,
    PromptedCriteriaPanelComponent,
    QueryCanvasComponent,
    QueryColumnGridComponent,
    QueryPropertiesPanelComponent,
    QuerySqlPanelComponent,
    WorkspaceToolbarComponent,
  ],
  templateUrl: './query-editor.component.html',
  styleUrl: './query-editor.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class QueryEditorComponent {
  private readonly initialLayout = readEditorLayoutPreference();
  protected readonly store = inject(QueryEditorStore);
  protected readonly tabs = tabs;
  protected readonly activeTab = signal<EditorTab>('query');
  protected readonly activeHorizontalResize = signal<HorizontalResizeTarget | null>(null);
  protected readonly datasourcePanelWidth = signal(this.initialLayout.datasourcePanelWidth);
  protected readonly querySidePanelWidth = signal(this.initialLayout.querySidePanelWidth);
  protected readonly columnGridHeight = signal(this.initialLayout.columnGridHeight);
  protected readonly columnGridPanelHeight = computed(
    () => `${this.columnGridHeight() + columnGridResizerHeight}px`,
  );

  protected setActiveTab(tab: EditorTab): void {
    if (tab === 'crosstab') {
      this.store.selectMainQuery();
    }

    this.activeTab.set(tab);
  }

  protected setColumnGridHeight(height: number): void {
    this.columnGridHeight.set(clamp(height, minColumnGridHeight, maxColumnGridHeight));
    this.persistLayoutPreference();
  }

  protected startHorizontalResize(target: HorizontalResizeTarget, event: PointerEvent): void {
    event.preventDefault();

    const startX = event.clientX;
    const startWidth =
      target === 'datasource' ? this.datasourcePanelWidth() : this.querySidePanelWidth();
    const previousCursor = document.body.style.cursor;
    const previousUserSelect = document.body.style.userSelect;
    this.activeHorizontalResize.set(target);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    const handlePointerMove = (pointerEvent: PointerEvent): void => {
      const deltaX = pointerEvent.clientX - startX;
      const nextWidth = target === 'datasource' ? startWidth + deltaX : startWidth - deltaX;

      this.setHorizontalPanelWidth(target, nextWidth);
    };

    const stopResize = (): void => {
      this.activeHorizontalResize.set(null);
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', stopResize);
      window.removeEventListener('pointercancel', stopResize);
    };

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', stopResize);
    window.addEventListener('pointercancel', stopResize);
  }

  protected resizeDatasourcePanelBy(delta: number): void {
    this.setHorizontalPanelWidth('datasource', this.datasourcePanelWidth() + delta);
  }

  protected resizeQuerySidePanelBy(delta: number): void {
    this.setHorizontalPanelWidth('query-side', this.querySidePanelWidth() + delta);
  }

  protected handleDatasourceResizerKeydown(event: KeyboardEvent): void {
    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      this.resizeDatasourcePanelBy(-panelResizeStep);
    } else if (event.key === 'ArrowRight') {
      event.preventDefault();
      this.resizeDatasourcePanelBy(panelResizeStep);
    }
  }

  protected handleQuerySideResizerKeydown(event: KeyboardEvent): void {
    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      this.resizeQuerySidePanelBy(panelResizeStep);
    } else if (event.key === 'ArrowRight') {
      event.preventDefault();
      this.resizeQuerySidePanelBy(-panelResizeStep);
    }
  }

  private setHorizontalPanelWidth(target: HorizontalResizeTarget, width: number): void {
    if (target === 'datasource') {
      this.datasourcePanelWidth.set(
        clamp(width, minDatasourcePanelWidth, this.maxDatasourcePanelWidth()),
      );
      this.persistLayoutPreference();
      return;
    }

    this.querySidePanelWidth.set(
      clamp(width, minQuerySidePanelWidth, this.maxQuerySidePanelWidth()),
    );
    this.persistLayoutPreference();
  }

  private maxDatasourcePanelWidth(): number {
    return Math.min(
      maxDatasourcePanelWidth,
      Math.max(defaultDatasourcePanelWidth, getViewportWidth() - 760),
    );
  }

  private maxQuerySidePanelWidth(): number {
    return Math.min(
      maxQuerySidePanelWidth,
      Math.max(defaultQuerySidePanelWidth, getViewportWidth() - 760),
    );
  }

  private persistLayoutPreference(): void {
    writeEditorLayoutPreference({
      datasourcePanelWidth: this.datasourcePanelWidth(),
      querySidePanelWidth: this.querySidePanelWidth(),
      columnGridHeight: this.columnGridHeight(),
    });
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function readEditorLayoutPreference(): EditorLayoutPreference {
  const fallback: EditorLayoutPreference = {
    datasourcePanelWidth: defaultDatasourcePanelWidth,
    querySidePanelWidth: defaultQuerySidePanelWidth,
    columnGridHeight: defaultColumnGridHeight,
  };

  try {
    const value = globalThis.localStorage?.getItem(layoutStorageKey);
    const parsedValue = value ? JSON.parse(value) : null;

    if (!isRecord(parsedValue)) {
      return fallback;
    }

    return {
      datasourcePanelWidth: readStoredNumber(
        parsedValue['datasourcePanelWidth'],
        fallback.datasourcePanelWidth,
        minDatasourcePanelWidth,
        maxDatasourcePanelWidth,
      ),
      querySidePanelWidth: readStoredNumber(
        parsedValue['querySidePanelWidth'],
        fallback.querySidePanelWidth,
        minQuerySidePanelWidth,
        maxQuerySidePanelWidth,
      ),
      columnGridHeight: readStoredNumber(
        parsedValue['columnGridHeight'],
        fallback.columnGridHeight,
        minColumnGridHeight,
        maxColumnGridHeight,
      ),
    };
  } catch {
    return fallback;
  }
}

function writeEditorLayoutPreference(preference: EditorLayoutPreference): void {
  try {
    globalThis.localStorage?.setItem(layoutStorageKey, JSON.stringify(preference));
  } catch {
    // Local storage is optional UI state; ignore quota/privacy errors.
  }
}

function readStoredNumber(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? clamp(value, min, max) : fallback;
}

function getViewportWidth(): number {
  return typeof window === 'undefined' ? 1440 : window.innerWidth;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
