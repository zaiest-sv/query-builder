export const QUERY_TABLE_DRAG_TYPE = 'application/x-query-builder-table';

export interface QueryTableDragPayload {
  readonly tableId: string;
}

export function writeTableDragData(dataTransfer: DataTransfer, tableId: string): void {
  const payload: QueryTableDragPayload = { tableId };

  dataTransfer.effectAllowed = 'copyMove';
  dataTransfer.setData(QUERY_TABLE_DRAG_TYPE, JSON.stringify(payload));
  dataTransfer.setData('text/plain', tableId);
}

export function readTableDragData(dataTransfer: DataTransfer): QueryTableDragPayload | null {
  const rawPayload = dataTransfer.getData(QUERY_TABLE_DRAG_TYPE);

  if (!rawPayload) {
    return null;
  }

  try {
    const payload = JSON.parse(rawPayload) as Partial<QueryTableDragPayload>;

    return typeof payload.tableId === 'string' && payload.tableId
      ? { tableId: payload.tableId }
      : null;
  } catch {
    return null;
  }
}
