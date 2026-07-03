import { ComponentFixture, TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import { DATA_SOURCE_GROUPS, MOCK_REPORT, MOCK_ROWS } from './data/mock-report-data';
import { ReportDefinition } from './models/report-definition.model';
import { QUERY_EDITOR_API, QueryEditorApi } from './services/query-editor-api.service';
import { QueryEditorComponent } from './query-editor.component';

const layoutStorageKey = 'query-builder.editor-layout.v2';

describe('QueryEditorComponent layout preferences', () => {
  let fixture: ComponentFixture<QueryEditorComponent>;

  beforeEach(async () => {
    localStorage.removeItem(layoutStorageKey);

    const api: QueryEditorApi = {
      loadReport: () =>
        of({
          metadata: structuredClone(DATA_SOURCE_GROUPS),
          report: structuredClone(MOCK_REPORT),
          rows: structuredClone(MOCK_ROWS),
        }),
      saveReport: (report: ReportDefinition) =>
        of({
          report: structuredClone(report),
          savedAt: '2026-07-01T00:00:00.000Z',
          message: 'Saved',
        }),
    };

    await TestBed.configureTestingModule({
      imports: [QueryEditorComponent],
      providers: [{ provide: QUERY_EDITOR_API, useValue: api }],
    }).compileComponents();
  });

  afterEach(() => {
    localStorage.removeItem(layoutStorageKey);
    TestBed.resetTestingModule();
  });

  it('restores persisted panel widths and column grid height', async () => {
    localStorage.setItem(
      layoutStorageKey,
      JSON.stringify({
        datasourcePanelWidth: 444,
        querySidePanelWidth: 512,
        columnGridHeight: 210,
      }),
    );

    fixture = TestBed.createComponent(QueryEditorComponent);
    fixture.detectChanges();
    await fixture.whenStable();

    const element = fixture.nativeElement as HTMLElement;
    const datasourceResizer = element.querySelector<HTMLButtonElement>(
      '[aria-label="Resize datasource panel"]',
    );
    const querySideResizer = element.querySelector<HTMLButtonElement>(
      '[aria-label="Resize properties and SQL panel"]',
    );
    const canvasPanel = element.querySelector<HTMLElement>('.canvas-panel');

    expect(datasourceResizer?.getAttribute('aria-valuenow')).toBe('444');
    expect(querySideResizer?.getAttribute('aria-valuenow')).toBe('512');
    expect(canvasPanel?.style.getPropertyValue('--query-column-grid-height')).toBe('220px');
  });

  it('persists keyboard panel resizing and column grid resizing', async () => {
    fixture = TestBed.createComponent(QueryEditorComponent);
    fixture.detectChanges();
    await fixture.whenStable();

    const element = fixture.nativeElement as HTMLElement;
    const datasourceResizer = element.querySelector<HTMLButtonElement>(
      '[aria-label="Resize datasource panel"]',
    );

    datasourceResizer?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft' }));
    (
      fixture.componentInstance as unknown as { setColumnGridHeight(height: number): void }
    ).setColumnGridHeight(240);
    fixture.detectChanges();

    const storedLayout = JSON.parse(localStorage.getItem(layoutStorageKey) ?? '{}') as {
      readonly datasourcePanelWidth?: number;
      readonly columnGridHeight?: number;
    };

    expect(storedLayout.datasourcePanelWidth).toBe(296);
    expect(storedLayout.columnGridHeight).toBe(240);
  });

  it('collapses and expands properties and SQL side panels', async () => {
    fixture = TestBed.createComponent(QueryEditorComponent);
    fixture.detectChanges();
    await fixture.whenStable();

    const element = fixture.nativeElement as HTMLElement;
    const propertiesPanel = element.querySelector('app-query-properties-panel');
    const sqlPanel = element.querySelector('app-query-sql-panel');
    const collapseProperties = element.querySelector<HTMLButtonElement>(
      '[aria-label="Collapse properties"]',
    );
    const collapseSql = element.querySelector<HTMLButtonElement>('[aria-label="Collapse SQL"]');

    collapseProperties?.click();
    collapseSql?.click();
    fixture.detectChanges();

    expect(propertiesPanel?.classList).toContain('query-side-card--collapsed');
    expect(sqlPanel?.classList).toContain('query-side-card--collapsed');

    element.querySelector<HTMLButtonElement>('[aria-label="Expand properties"]')?.click();
    element.querySelector<HTMLButtonElement>('[aria-label="Expand SQL"]')?.click();
    fixture.detectChanges();

    expect(propertiesPanel?.classList).not.toContain('query-side-card--collapsed');
    expect(sqlPanel?.classList).not.toContain('query-side-card--collapsed');
  });
});
