import { ComponentFixture, TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import { DATA_SOURCE_GROUPS, MOCK_REPORT, MOCK_ROWS } from '../../data/mock-report-data';
import { ReportDefinition } from '../../models/report-definition.model';
import { QUERY_EDITOR_API, QueryEditorApi } from '../../services/query-editor-api.service';
import { QueryEditorStore } from '../../services/query-editor-store.service';
import { QueryColumnGridComponent } from './query-column-grid.component';

describe('QueryColumnGridComponent', () => {
  let fixture: ComponentFixture<QueryColumnGridComponent>;
  let store: QueryEditorStore;

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
      imports: [QueryColumnGridComponent],
      providers: [{ provide: QUERY_EDITOR_API, useValue: api }],
    }).compileComponents();

    store = TestBed.inject(QueryEditorStore);
    store.loadReport(MOCK_REPORT.id);
    fixture = TestBed.createComponent(QueryColumnGridComponent);
    fixture.componentRef.setInput('gridHeight', 160);
    fixture.detectChanges();
    await fixture.whenStable();
  });

  afterEach(() => {
    TestBed.resetTestingModule();
  });

  it('edits column criteria through the modal editor', () => {
    const element = fixture.nativeElement as HTMLElement;
    const criteriaButton = element.querySelector<HTMLButtonElement>(
      '[aria-label="Edit column criteria"]',
    );

    criteriaButton?.click();
    fixture.detectChanges();

    const textarea = element.querySelector<HTMLTextAreaElement>('.editor-modal textarea');
    const applyButton = Array.from(
      element.querySelectorAll<HTMLButtonElement>('.editor-modal button'),
    ).find((button) => button.textContent?.trim() === 'Apply');

    expect(textarea).toBeTruthy();
    textarea!.value = '= Completed';
    textarea!.dispatchEvent(new Event('input', { bubbles: true }));
    applyButton?.click();
    fixture.detectChanges();

    expect(store.report().query.columns[0]?.criteria).toBe('= Completed');
    expect(element.querySelector('.editor-modal')).toBeNull();
  });
});
