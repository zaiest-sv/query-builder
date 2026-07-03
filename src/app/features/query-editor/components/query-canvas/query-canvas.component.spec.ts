import { ComponentFixture, TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import { DATA_SOURCE_GROUPS, MOCK_REPORT, MOCK_ROWS } from '../../data/mock-report-data';
import { QUERY_TABLE_DRAG_TYPE } from '../../models/query-editor-drag-drop.model';
import { ReportDefinition } from '../../models/report-definition.model';
import { QUERY_EDITOR_API, QueryEditorApi } from '../../services/query-editor-api.service';
import { QueryEditorStore } from '../../services/query-editor-store.service';
import { QueryCanvasComponent } from './query-canvas.component';

describe('QueryCanvasComponent', () => {
  let fixture: ComponentFixture<QueryCanvasComponent>;

  beforeEach(async () => {
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
      imports: [QueryCanvasComponent],
      providers: [{ provide: QUERY_EDITOR_API, useValue: api }],
    }).compileComponents();

    TestBed.inject(QueryEditorStore).loadReport(MOCK_REPORT.id);
    fixture = TestBed.createComponent(QueryCanvasComponent);
    fixture.detectChanges();
    await fixture.whenStable();
  });

  afterEach(() => {
    TestBed.resetTestingModule();
  });

  it('renders selected datasource tables as draggable cards', () => {
    const element = fixture.nativeElement as HTMLElement;
    const tableTitles = Array.from(element.querySelectorAll('.table-card strong')).map((title) =>
      title.textContent?.trim(),
    );

    expect(tableTitles).toEqual(['Encounters', 'Patients', 'Financial Ledger']);
    expect(element.querySelectorAll('.table-card__header[aria-grabbed]').length).toBe(3);
  });

  it('exposes original table menu actions including wrap into derived table', () => {
    const element = fixture.nativeElement as HTMLElement;
    const menuButton = element.querySelector<HTMLButtonElement>('.table-card__menu');

    menuButton?.click();
    fixture.detectChanges();

    const menuActions = Array.from(element.querySelectorAll('.table-menu button')).map((button) =>
      button.textContent?.trim(),
    );

    expect(menuActions).toContain('Hide Unused Fields');
    expect(menuActions).toContain('Sort Fields Alphabetically');
    expect(menuActions).toContain('Check All');
    expect(menuActions).toContain('Uncheck All');
    expect(menuActions).toContain('Wrap into derived table');
    expect(menuActions).toContain('Properties');
  });

  it('marks joined field rows on the side where the connector is anchored', () => {
    const element = fixture.nativeElement as HTMLElement;
    const canvas = element.querySelector<HTMLElement>('.query-canvas');

    expect(canvas).toBeTruthy();
    setElementRect(canvas, rect(0, 0, 1200, 600));
    setFieldRect(element, 'Encounter.EncounterId', rect(20, 78, 320, 32));
    setFieldRect(element, 'Encounter.PatientId', rect(20, 110, 320, 32));
    setFieldRect(element, 'Patient.PatientId', rect(420, 130, 320, 32));
    setFieldRect(element, 'FinancialLedger.EncounterId', rect(780, 160, 320, 32));

    (fixture.componentInstance as unknown as { refreshJoinPaths(): void }).refreshJoinPaths();
    fixture.detectChanges();

    expect(fieldRow(element, 'Encounter.PatientId')?.classList).toContain(
      'canvas-field-row--joined-right',
    );
    expect(fieldRow(element, 'Encounter.EncounterId')?.classList).toContain(
      'canvas-field-row--joined-right',
    );
    expect(fieldRow(element, 'Patient.PatientId')?.classList).toContain(
      'canvas-field-row--joined-left',
    );
    expect(fieldRow(element, 'FinancialLedger.EncounterId')?.classList).toContain(
      'canvas-field-row--joined-left',
    );
  });

  it('drops a datasource table onto the canvas at the pointer position', () => {
    const element = fixture.nativeElement as HTMLElement;
    const store = TestBed.inject(QueryEditorStore);
    const canvas = element.querySelector<HTMLElement>('.query-canvas');

    expect(canvas).toBeTruthy();
    expect(store.report().query.sourceTableIds).not.toContain('Diagnosis');

    setElementRect(canvas, rect(100, 120, 900, 520));
    canvas?.dispatchEvent(
      createTableDropEvent('Diagnosis', {
        clientX: 360,
        clientY: 300,
      }),
    );
    fixture.detectChanges();

    expect(store.report().query.sourceTableIds).toContain('Diagnosis');
    expect(store.canvasTablePositions().get('Diagnosis')).toEqual({
      tableId: 'Diagnosis',
      x: 236,
      y: 156,
    });
    expect(store.canvasSelection()).toEqual({ kind: 'table', tableId: 'Diagnosis' });
  });
});

function fieldRow(root: HTMLElement, fieldId: string): HTMLElement | null {
  return root.querySelector<HTMLElement>(`[data-field-id="${fieldId}"]`);
}

function setFieldRect(root: HTMLElement, fieldId: string, nextRect: DOMRect): void {
  const row = fieldRow(root, fieldId);

  expect(row).toBeTruthy();
  setElementRect(row, nextRect);
}

function setElementRect(element: HTMLElement | null, nextRect: DOMRect): void {
  if (!element) {
    return;
  }

  element.getBoundingClientRect = () => nextRect;
  Object.defineProperty(element, 'clientWidth', {
    configurable: true,
    value: nextRect.width,
  });
  Object.defineProperty(element, 'clientHeight', {
    configurable: true,
    value: nextRect.height,
  });
  Object.defineProperty(element, 'scrollWidth', {
    configurable: true,
    value: nextRect.width,
  });
  Object.defineProperty(element, 'scrollHeight', {
    configurable: true,
    value: nextRect.height,
  });
}

function rect(left: number, top: number, width: number, height: number): DOMRect {
  return {
    x: left,
    y: top,
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    toJSON: () => ({}),
  };
}

function createTableDropEvent(
  tableId: string,
  position: Pick<MouseEvent, 'clientX' | 'clientY'>,
): DragEvent {
  const event = new Event('drop', { bubbles: true, cancelable: true }) as DragEvent;
  const data = new Map<string, string>([
    [QUERY_TABLE_DRAG_TYPE, JSON.stringify({ tableId })],
    ['text/plain', tableId],
  ]);

  Object.defineProperty(event, 'clientX', {
    configurable: true,
    value: position.clientX,
  });
  Object.defineProperty(event, 'clientY', {
    configurable: true,
    value: position.clientY,
  });
  Object.defineProperty(event, 'dataTransfer', {
    configurable: true,
    value: {
      dropEffect: 'copy',
      getData: (type: string) => data.get(type) ?? '',
      setData: (type: string, value: string) => data.set(type, value),
    },
  });

  return event;
}
