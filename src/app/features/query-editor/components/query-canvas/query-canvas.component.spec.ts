import { ComponentFixture, TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import { DATA_SOURCE_GROUPS, MOCK_REPORT, MOCK_ROWS } from '../../data/mock-report-data';
import { ReportDefinition } from '../../models/report-definition.model';
import { QUERY_EDITOR_API, QueryEditorApi } from '../../services/query-editor-api.service';
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
