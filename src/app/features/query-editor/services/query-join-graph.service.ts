import { Injectable } from '@angular/core';
import {
  DataSourceField,
  DataSourceTable,
  QueryJoin,
  QueryJoinCondition,
  QueryJoinOperator,
} from '../models/report-definition.model';

export type JoinDropMode = 'create' | 'condition' | 'invalid';

export interface JoinDropAssessment {
  readonly mode: JoinDropMode;
  readonly canDrop: boolean;
  readonly message: string;
  readonly targetJoinId?: string;
}

export interface JoinConditionCandidate {
  readonly fromFieldId: string;
  readonly operator: QueryJoinOperator;
  readonly toFieldId: string;
}

@Injectable({ providedIn: 'root' })
export class QueryJoinGraphService {
  assessJoinDrop(
    fromFieldId: string,
    toFieldId: string,
    joins: readonly QueryJoin[],
    fieldLookup: ReadonlyMap<string, DataSourceField>,
  ): JoinDropAssessment {
    const fromField = fieldLookup.get(fromFieldId);
    const toField = fieldLookup.get(toFieldId);

    if (!fromField || !toField) {
      return {
        mode: 'invalid',
        canDrop: false,
        message: 'Drop on a datasource field.',
      };
    }

    if (fromField.id === toField.id) {
      return {
        mode: 'invalid',
        canDrop: false,
        message: 'Choose a different field.',
      };
    }

    if (fromField.tableId === toField.tableId) {
      return {
        mode: 'invalid',
        canDrop: false,
        message: 'Fields from the same table cannot be joined.',
      };
    }

    if (joins.some((join) => joinHasCondition(join, fromFieldId, toFieldId))) {
      return {
        mode: 'invalid',
        canDrop: false,
        message: 'This join condition already exists.',
      };
    }

    const existingJoin = joins.find((join) =>
      joinConnectsTables(join, fromField.tableId, toField.tableId, fieldLookup),
    );

    return existingJoin
      ? {
          mode: 'condition',
          canDrop: true,
          message: 'Add condition to existing join.',
          targetJoinId: existingJoin.id,
        }
      : {
          mode: 'create',
          canDrop: true,
          message: 'Create join.',
        };
  }

  orientJoinConditionForJoin(
    join: QueryJoin,
    fromFieldId: string,
    toFieldId: string,
    fieldLookup: ReadonlyMap<string, DataSourceField>,
  ): JoinConditionCandidate | null {
    const fromField = fieldLookup.get(fromFieldId);
    const toField = fieldLookup.get(toFieldId);
    const baseCondition = join.conditions.find((condition) => {
      const baseFromField = fieldLookup.get(condition.fromFieldId);
      const baseToField = fieldLookup.get(condition.toFieldId);

      return baseFromField !== undefined && baseToField !== undefined;
    });
    const baseFromField = baseCondition ? fieldLookup.get(baseCondition.fromFieldId) : null;
    const baseToField = baseCondition ? fieldLookup.get(baseCondition.toFieldId) : null;

    if (!fromField || !toField || !baseFromField || !baseToField) {
      return null;
    }

    return fromField.tableId === baseToField.tableId && toField.tableId === baseFromField.tableId
      ? {
          fromFieldId: toFieldId,
          operator: 'equals',
          toFieldId: fromFieldId,
        }
      : {
          fromFieldId,
          operator: 'equals',
          toFieldId,
        };
  }

  findSuggestedJoinCondition(
    join: QueryJoin,
    tableLookup: ReadonlyMap<string, DataSourceTable>,
    fieldLookup: ReadonlyMap<string, DataSourceField>,
  ): JoinConditionCandidate | null {
    const baseCondition = join.conditions.find((condition) => {
      const fromField = fieldLookup.get(condition.fromFieldId);
      const toField = fieldLookup.get(condition.toFieldId);

      return (
        fromField !== undefined && toField !== undefined && fromField.tableId !== toField.tableId
      );
    });

    if (!baseCondition) {
      return null;
    }

    const fromField = fieldLookup.get(baseCondition.fromFieldId);
    const toField = fieldLookup.get(baseCondition.toFieldId);
    const fromTable = fromField ? tableLookup.get(fromField.tableId) : null;
    const toTable = toField ? tableLookup.get(toField.tableId) : null;

    if (!fromTable || !toTable) {
      return null;
    }

    const usedConditions = new Set(join.conditions.map((condition) => joinConditionKey(condition)));
    const candidates = fromTable.fields
      .flatMap((fromCandidate) =>
        toTable.fields.map((toCandidate) => ({
          condition: {
            fromFieldId: fromCandidate.id,
            operator: 'equals' as const,
            toFieldId: toCandidate.id,
          },
          score: scoreFieldMatch(fromCandidate, toCandidate),
        })),
      )
      .filter((candidate) => !usedConditions.has(joinConditionKey(candidate.condition)))
      .sort((first, second) => {
        if (second.score !== first.score) {
          return second.score - first.score;
        }

        const firstLabel = `${fieldLookup.get(first.condition.fromFieldId)?.name ?? ''}.${fieldLookup.get(first.condition.toFieldId)?.name ?? ''}`;
        const secondLabel = `${fieldLookup.get(second.condition.fromFieldId)?.name ?? ''}.${fieldLookup.get(second.condition.toFieldId)?.name ?? ''}`;

        return firstLabel.localeCompare(secondLabel);
      });

    return candidates[0]?.condition ?? null;
  }
}

export function joinTouchesTable(
  join: QueryJoin,
  tableId: string,
  fieldLookup: ReadonlyMap<string, DataSourceField>,
): boolean {
  return join.conditions.some((condition) => {
    const fromField = fieldLookup.get(condition.fromFieldId);
    const toField = fieldLookup.get(condition.toFieldId);

    return fromField?.tableId === tableId || toField?.tableId === tableId;
  });
}

export function findDuplicateJoinConditionIds(
  conditions: readonly QueryJoinCondition[],
): ReadonlySet<string> {
  const conditionIdsByKey = new Map<string, string[]>();

  for (const condition of conditions) {
    const key = joinConditionKey(condition);
    const conditionIds = conditionIdsByKey.get(key) ?? [];
    conditionIds.push(condition.id);
    conditionIdsByKey.set(key, conditionIds);
  }

  return new Set(
    Array.from(conditionIdsByKey.values())
      .filter((conditionIds) => conditionIds.length > 1)
      .flat(),
  );
}

export function areJoinConditionsEqual(
  left: QueryJoinCondition,
  right: QueryJoinCondition,
): boolean {
  return (
    left.id === right.id &&
    left.fromFieldId === right.fromFieldId &&
    left.operator === right.operator &&
    left.toFieldId === right.toFieldId
  );
}

function joinHasCondition(join: QueryJoin, fromFieldId: string, toFieldId: string): boolean {
  return join.conditions.some((condition) =>
    isSameJoinCondition(condition, fromFieldId, toFieldId),
  );
}

function isSameJoinCondition(
  condition: QueryJoinCondition,
  fromFieldId: string,
  toFieldId: string,
): boolean {
  return (
    (condition.fromFieldId === fromFieldId && condition.toFieldId === toFieldId) ||
    (condition.fromFieldId === toFieldId && condition.toFieldId === fromFieldId)
  );
}

function joinConnectsTables(
  join: QueryJoin,
  firstTableId: string,
  secondTableId: string,
  fieldLookup: ReadonlyMap<string, DataSourceField>,
): boolean {
  return join.conditions.some((condition) => {
    const fromField = fieldLookup.get(condition.fromFieldId);
    const toField = fieldLookup.get(condition.toFieldId);

    return (
      (fromField?.tableId === firstTableId && toField?.tableId === secondTableId) ||
      (fromField?.tableId === secondTableId && toField?.tableId === firstTableId)
    );
  });
}

function joinConditionKey(condition: JoinConditionCandidate | QueryJoinCondition): string {
  return `${condition.fromFieldId}|${condition.operator}|${condition.toFieldId}`;
}

function scoreFieldMatch(fromField: DataSourceField, toField: DataSourceField): number {
  const fromName = normalizeFieldName(fromField.name);
  const toName = normalizeFieldName(toField.name);
  const sharedTokens = fieldTokens(fromField.name).filter((token) =>
    fieldTokens(toField.name).includes(token),
  );
  let score = 0;

  if (fromName === toName) {
    score += 120;
  }

  if (stripIdentifierSuffix(fromName) === stripIdentifierSuffix(toName)) {
    score += 44;
  }

  if (fromField.type === toField.type) {
    score += 34;
  } else {
    score -= 26;
  }

  if (fromName.endsWith('id') && toName.endsWith('id')) {
    score += 22;
  }

  return score + sharedTokens.length * 10;
}

function normalizeFieldName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function stripIdentifierSuffix(value: string): string {
  return value.endsWith('id') ? value.slice(0, -2) : value;
}

function fieldTokens(value: string): readonly string[] {
  const tokenizedValue = value.replace(/([a-z])([A-Z])/g, '$1 $2');

  return tokenizedValue
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 1);
}
