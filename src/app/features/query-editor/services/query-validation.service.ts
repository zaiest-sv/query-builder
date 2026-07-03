import { inject, Injectable } from '@angular/core';
import {
  DataSourceField,
  DataSourceTable,
  QueryJoin,
  QueryDocument,
  QuerySubquery,
  ReportDefinition,
} from '../models/report-definition.model';
import { QueryCrosstabConfigService } from './query-crosstab-config.service';
import {
  findConflictingJoinPairIds,
  findDuplicateJoinPairIds,
  getJoinTablePair,
} from './query-join-graph.service';
import { createSubqueryTableId, parseSubqueryTableId } from './query-subquery-datasource.service';

export type QueryValidationSeverity = 'error' | 'warning';

export interface QueryValidationIssue {
  readonly severity: QueryValidationSeverity;
  readonly message: string;
}

@Injectable({ providedIn: 'root' })
export class QueryValidationService {
  private readonly crosstabConfig = inject(QueryCrosstabConfigService);

  validateActiveQuery(
    query: QueryDocument,
    subquery: QuerySubquery | null,
    report: ReportDefinition,
    tableLookup: ReadonlyMap<string, DataSourceTable>,
    fieldLookup: ReadonlyMap<string, DataSourceField>,
  ): readonly string[] {
    return this.validateActiveQueryIssues(
      query,
      subquery,
      report,
      tableLookup,
      fieldLookup,
    ).map((issue) => issue.message);
  }

  validateActiveQueryIssues(
    query: QueryDocument,
    subquery: QuerySubquery | null,
    report: ReportDefinition,
    tableLookup: ReadonlyMap<string, DataSourceTable>,
    fieldLookup: ReadonlyMap<string, DataSourceField>,
  ): readonly QueryValidationIssue[] {
    const issues = [
      ...this.validateQueryDocument(
        query,
        subquery?.name ?? 'Main query',
        tableLookup,
        fieldLookup,
        {
          selfSourceTableId: subquery ? createSubqueryTableId(subquery.id) : '',
          requireVisibleOutputColumn: subquery !== null,
        },
      ),
    ];

    if (subquery && this.dependsOnSubquery(report, subquery.id, subquery.id)) {
      issues.push(`${subquery.name}: circular subquery datasource dependency.`);
    }

    return issues.map(createErrorIssue);
  }

  validateReport(
    report: ReportDefinition,
    tableLookup: ReadonlyMap<string, DataSourceTable>,
    fieldLookup: ReadonlyMap<string, DataSourceField>,
  ): readonly string[] {
    return this.validateReportIssues(report, tableLookup, fieldLookup).map(
      (issue) => issue.message,
    );
  }

  validateReportIssues(
    report: ReportDefinition,
    tableLookup: ReadonlyMap<string, DataSourceTable>,
    fieldLookup: ReadonlyMap<string, DataSourceField>,
  ): readonly QueryValidationIssue[] {
    const issues: string[] = [
      ...this.validateQueryDocument(report.query, 'Main query', tableLookup, fieldLookup),
    ];

    const crosstabDefinition = this.crosstabConfig.normalizeDefinition(
      report.crosstab,
      report.query.columns,
    );
    const crosstabFieldLookup = new Map(
      this.crosstabConfig
        .createOutputFields(report.query.columns, fieldLookup)
        .map((field) => [field.id, field] as const),
    );

    for (const fieldId of crosstabDefinition.rowFieldIds) {
      if (!crosstabFieldLookup.has(fieldId)) {
        issues.push(`Crosstab row field ${fieldId} is not a Main query column.`);
      }
    }

    for (const fieldId of crosstabDefinition.columnFieldIds) {
      if (!crosstabFieldLookup.has(fieldId)) {
        issues.push(`Crosstab column field ${fieldId} is not a Main query column.`);
      }
    }

    for (const value of crosstabDefinition.values) {
      const field = crosstabFieldLookup.get(value.fieldId);

      if (!field) {
        issues.push(`Crosstab value ${value.label} is not a Main query column.`);
      } else if (!field.aggregations.includes(value.aggregation)) {
        issues.push(`${value.aggregation.toUpperCase()} is not supported for ${field.label}.`);
      }
    }

    const subqueryAliases = new Set<string>();
    const subqueryNames = new Set<string>();

    for (const subquery of report.subqueries) {
      const alias = subquery.alias.trim().toLowerCase();
      const name = subquery.name.trim().toLowerCase();

      if (!name) {
        issues.push(`Subquery ${subquery.id} name cannot be empty.`);
      } else if (subqueryNames.has(name)) {
        issues.push(`Subquery name ${subquery.name} is duplicated.`);
      } else {
        subqueryNames.add(name);
      }

      if (!alias) {
        issues.push(`Subquery ${subquery.name} alias cannot be empty.`);
      } else if (subqueryAliases.has(alias)) {
        issues.push(`Subquery alias ${subquery.alias} is duplicated.`);
      } else {
        subqueryAliases.add(alias);
      }

      if (
        subquery.settings?.previewLimit !== undefined &&
        (subquery.settings.previewLimit < 1 || subquery.settings.previewLimit > 500)
      ) {
        issues.push(`Subquery ${subquery.name} preview limit must be between 1 and 500.`);
      }

      issues.push(
        ...this.validateQueryDocument(
          subquery.query,
          `Subquery ${subquery.name}`,
          tableLookup,
          fieldLookup,
          {
            selfSourceTableId: createSubqueryTableId(subquery.id),
            requireVisibleOutputColumn: true,
          },
        ),
      );

      if (this.dependsOnSubquery(report, subquery.id, subquery.id)) {
        issues.push(`Subquery ${subquery.name} has a circular datasource dependency.`);
      }
    }

    return issues.map((message) =>
      isWarningValidationMessage(message) ? createWarningIssue(message) : createErrorIssue(message),
    );
  }

  dependsOnSubquery(
    report: ReportDefinition,
    sourceSubqueryId: string,
    targetSubqueryId: string,
    visitedSubqueryIds: ReadonlySet<string> = new Set(),
  ): boolean {
    if (visitedSubqueryIds.has(sourceSubqueryId)) {
      return false;
    }

    const sourceSubquery = report.subqueries.find((subquery) => subquery.id === sourceSubqueryId);

    if (!sourceSubquery) {
      return false;
    }

    const nextVisitedSubqueryIds = new Set(visitedSubqueryIds);
    nextVisitedSubqueryIds.add(sourceSubqueryId);

    return sourceSubquery.query.sourceTableIds.some((tableId) => {
      const dependencySubqueryId = parseSubqueryTableId(tableId);

      if (!dependencySubqueryId) {
        return false;
      }

      return (
        dependencySubqueryId === targetSubqueryId ||
        this.dependsOnSubquery(
          report,
          dependencySubqueryId,
          targetSubqueryId,
          nextVisitedSubqueryIds,
        )
      );
    });
  }

  private validateQueryDocument(
    query: QueryDocument,
    label: string,
    tableLookup: ReadonlyMap<string, DataSourceTable>,
    fieldLookup: ReadonlyMap<string, DataSourceField>,
    options: {
      readonly selfSourceTableId?: string;
      readonly requireVisibleOutputColumn?: boolean;
    } = {},
  ): readonly string[] {
    const issues: string[] = [];
    const aliases = new Set<string>();
    const parameterNames = new Set<string>();
    const dynamicSourceFieldIds = new Set<string>();

    if (query.sourceTableIds.length === 0) {
      issues.push(`${label}: select at least one datasource table.`);
    }

    if (query.columns.length === 0) {
      issues.push(`${label}: add at least one query column.`);
    }

    if (options.requireVisibleOutputColumn && !query.columns.some((column) => column.visible)) {
      issues.push(`${label}: select at least one visible output column.`);
    }

    for (const tableId of query.sourceTableIds) {
      if (options.selfSourceTableId && tableId === options.selfSourceTableId) {
        issues.push(`${label}: cannot use itself as a datasource.`);
      } else if (!tableLookup.has(tableId)) {
        issues.push(`${label}: datasource ${tableId} is no longer available.`);
      }
    }

    for (const column of query.columns) {
      const field = fieldLookup.get(column.fieldId);

      if (!field) {
        issues.push(`${label}: column ${column.alias} points to a missing field.`);
      } else if (!query.sourceTableIds.includes(field.tableId)) {
        issues.push(`${label}: column ${column.alias} uses an unselected datasource.`);
      }

      const normalizedAlias = column.alias.trim().toLowerCase();

      if (!normalizedAlias) {
        issues.push(`${label}: column aliases cannot be empty.`);
      } else if (aliases.has(normalizedAlias)) {
        issues.push(`${label}: column alias ${column.alias} is duplicated.`);
      } else {
        aliases.add(normalizedAlias);
      }
    }

    for (const filter of query.filters) {
      const field = fieldLookup.get(filter.fieldId);

      if (!field) {
        issues.push(`${label}: filter ${filter.id} points to a missing field.`);
      } else if (!query.sourceTableIds.includes(field.tableId)) {
        issues.push(`${label}: filter on ${field.label} uses an unselected datasource.`);
      }

      if (filter.parameterName && !/^[A-Za-z][A-Za-z0-9_]*$/.test(filter.parameterName)) {
        issues.push(
          `${label}: parameter ${filter.parameterName} must start with a letter and use letters, numbers, or underscores.`,
        );
      } else if (
        filter.parameterName &&
        !query.parameters.some((parameter) => parameter.name === filter.parameterName)
      ) {
        issues.push(
          `${label}: filter on ${field?.label ?? filter.id} uses a missing prompt parameter.`,
        );
      }
    }

    for (const parameter of query.parameters) {
      const normalizedName = parameter.name.trim();

      if (!normalizedName) {
        issues.push(`${label}: prompt parameter names cannot be empty.`);
      } else if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(normalizedName)) {
        issues.push(
          `${label}: parameter ${parameter.name} must start with a letter and use letters, numbers, or underscores.`,
        );
      } else if (parameterNames.has(normalizedName.toLowerCase())) {
        issues.push(`${label}: parameter ${parameter.name} is duplicated.`);
      } else {
        parameterNames.add(normalizedName.toLowerCase());
      }

      if (!parameter.label.trim()) {
        issues.push(`${label}: parameter ${parameter.name || parameter.id} label cannot be empty.`);
      }

      if (parameter.kind === 'dynamic') {
        const sourceFieldId = parameter.sourceFieldId ?? '';
        const sourceField = fieldLookup.get(sourceFieldId);

        if (!sourceFieldId) {
          issues.push(`${label}: dynamic parameter ${parameter.name} must select a source field.`);
        } else if (!sourceField) {
          issues.push(`${label}: dynamic parameter ${parameter.name} uses a missing source field.`);
        } else {
          if (!query.sourceTableIds.includes(sourceField.tableId)) {
            issues.push(
              `${label}: dynamic parameter ${parameter.name} uses an unselected datasource.`,
            );
          }

          if (sourceField.type !== parameter.type) {
            issues.push(
              `${label}: dynamic parameter ${parameter.name} type must match ${sourceField.label}.`,
            );
          }
        }

        if (sourceFieldId) {
          const normalizedSourceFieldId = sourceFieldId.toLowerCase();

          if (dynamicSourceFieldIds.has(normalizedSourceFieldId)) {
            issues.push(
              `${label}: dynamic criteria for ${sourceField?.label ?? sourceFieldId} is duplicated.`,
            );
          } else {
            dynamicSourceFieldIds.add(normalizedSourceFieldId);
          }
        }
      }

      if (parameter.lookup?.enabled) {
        if (parameter.lookup.options.length === 0) {
          issues.push(`${label}: lookup parameter ${parameter.name} must define options.`);
        }

        const selectedValues = parameter.lookup.multiple
          ? parameter.defaultValue
              .split(',')
              .map((value) => value.trim())
              .filter(Boolean)
          : parameter.defaultValue
            ? [parameter.defaultValue]
            : [];
        const optionSet = new Set(parameter.lookup.options.map((option) => option.toLowerCase()));
        const invalidValues = selectedValues.filter((value) => !optionSet.has(value.toLowerCase()));

        if (invalidValues.length > 0) {
          issues.push(
            `${label}: lookup parameter ${parameter.name} has values outside allowed options (${invalidValues.join(', ')}).`,
          );
        }
      }
    }

    for (const join of query.joins) {
      if (join.conditions.length === 0) {
        issues.push(`${label}: join ${join.id} must have at least one condition.`);
        continue;
      }

      for (const condition of join.conditions) {
        const fromField = fieldLookup.get(condition.fromFieldId);
        const toField = fieldLookup.get(condition.toFieldId);

        if (!fromField || !toField) {
          issues.push(`${label}: join ${join.id} points to a missing field.`);
          continue;
        }

        if (fromField.tableId === toField.tableId) {
          issues.push(`${label}: join ${join.id} connects fields from the same datasource.`);
        }

        if (
          !query.sourceTableIds.includes(fromField.tableId) ||
          !query.sourceTableIds.includes(toField.tableId)
        ) {
          issues.push(`${label}: join ${join.id} uses an unselected datasource.`);
        }
      }
    }

    issues.push(...createJoinPairIssues(query.joins, label, fieldLookup));

    return issues;
  }
}

function createErrorIssue(message: string): QueryValidationIssue {
  return { severity: 'error', message };
}

function createWarningIssue(message: string): QueryValidationIssue {
  return { severity: 'warning', message };
}

function isWarningValidationMessage(message: string): boolean {
  return message.startsWith('Crosstab ');
}

function createJoinPairIssues(
  joins: readonly QueryJoin[],
  label: string,
  fieldLookup: ReadonlyMap<string, DataSourceField>,
): readonly string[] {
  const issues: string[] = [];
  const duplicateJoinIds = findDuplicateJoinPairIds(joins, fieldLookup);
  const conflictingJoinIds = findConflictingJoinPairIds(joins, fieldLookup);
  const reportedPairKeys = new Set<string>();

  for (const join of joins) {
    if (!duplicateJoinIds.has(join.id)) {
      continue;
    }

    const pair = getJoinTablePair(join, fieldLookup);

    if (!pair || reportedPairKeys.has(pair.key)) {
      continue;
    }

    const joinsForPair = joins.filter(
      (currentJoin) => getJoinTablePair(currentJoin, fieldLookup)?.key === pair.key,
    );
    const joinIds = joinsForPair.map((currentJoin) => currentJoin.id).join(', ');
    const typeList = Array.from(new Set(joinsForPair.map((currentJoin) => currentJoin.type))).join(
      ', ',
    );

    issues.push(
      conflictingJoinIds.has(join.id)
        ? `${label}: joins ${joinIds} connect the same datasource pair with conflicting join types (${typeList}).`
        : `${label}: joins ${joinIds} connect the same datasource pair. Merge their conditions into one join.`,
    );
    reportedPairKeys.add(pair.key);
  }

  return issues;
}
