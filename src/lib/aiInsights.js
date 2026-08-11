import { DataScanner } from '@/lib/dataScanner';

export class AIInsightsEngine {
  constructor(scanner) {
    this.scanner = scanner || new DataScanner();
  }

  async generateComprehensiveInsights(scannedFiles, existingData, propertyContext) {
    const insights = [];
    const recommendations = [];
    const alerts = [];

    scannedFiles.forEach((file) => {
      insights.push(...this.generateFileLevelInsights(file));
    });

    insights.push(...this.generateCrossFileInsights(scannedFiles));

    if (existingData && Object.keys(existingData).length) {
      insights.push(...this.generateConsistencyInsights(scannedFiles, existingData));
    }

    if (propertyContext) {
      insights.push(...this.generatePropertyLevelInsights(scannedFiles, propertyContext));
    }

    const autoFixRecommendations = scannedFiles
      .filter((f) => (f?.issues || []).some((i) => i.applyAutoFix))
      .map((f) => ({
        type: 'auto_fix',
        file: f.fileName,
        issues: (f.issues || []).filter((i) => i.applyAutoFix).length,
        severity: 'info',
        title: 'Auto-fixable issues found',
        detail: `${(f.issues || []).filter((i) => i.applyAutoFix).length} issues can be automatically resolved.`,
        priority: 4,
        action: 'apply_auto_fix',
        params: { fileId: f.fileId, file: f.fileName },
      }));

    recommendations.push(...autoFixRecommendations);

    return {
      insights: insights.sort((a, b) => (a.priority || 99) - (b.priority || 99)),
      recommendations: recommendations.sort((a, b) => (a.priority || 99) - (b.priority || 99)),
      alerts: alerts.sort((a, b) => (a.priority || 99) - (b.priority || 99)),
      generatedAt: new Date().toISOString(),
    };
  }

  generateFileLevelInsights(file) {
    const insights = [];
    const issues = file.issues || [];

    const health = file.healthScore || { score: 100, grade: 'A' };

    if (health.score < 50) {
      insights.push({
        type: 'health',
        severity: 'critical',
        category: 'Data Health',
        title: `Critical data quality: ${file.fileName}`,
        detail: `Health score is ${health.score}/100 (${health.grade}). The file has ${issues.length} issues that need immediate attention.`,
        priority: 1,
        affectedFile: file.fileName,
        actionable: true,
        action: 'view_issues',
      });
    }

    const duplicates = issues.filter((i) => i.type === 'duplicate_row');
    if (duplicates.length) {
      const totalDups = duplicates.reduce((a, i) => a + (i.impact || 0), 0);
      insights.push({
        type: 'duplicate',
        severity: 'high',
        category: 'Data Quality',
        title: 'Duplicate rows inflating data',
        detail: `${totalDups} duplicate rows found across ${duplicates.length} groups. This will overstate metrics.`,
        priority: 2,
        affectedFile: file.fileName,
        actionable: true,
        action: 'remove_duplicates',
        fixable: true,
      });
    }

    const missing = issues.filter((i) => i.type === 'missing_values');
    if (missing.length) {
      const totalMissing = missing.reduce((a, i) => a + i.impact, 0);
      const cols = [...new Set(missing.map((i) => i.affectedHeader))];
      insights.push({
        type: 'missing',
        severity: 'medium',
        category: 'Data Quality',
        title: 'Missing values affect analysis',
        detail: `${totalMissing} missing values across ${missing.length} columns: ${cols.join(', ')}.`,
        priority: 3,
        affectedFile: file.fileName,
        actionable: true,
        action: 'fill_or_flag_missing',
        fixable: missing.some((i) => i.applyAutoFix),
      });
    }

    const outliers = issues.filter((i) => i.type === 'outlier');
    if (outliers.length) {
      insights.push({
        type: 'outlier',
        severity: 'medium',
        category: 'Data Quality',
        title: 'Outlier values detected',
        detail: `${outliers.length} columns contain statistical outliers (z-score > 3). Verify if these are data entry errors.`,
        priority: 3,
        affectedFile: file.fileName,
        actionable: true,
        action: 'review_outliers',
        fixable: false,
      });
    }

    const labels = issues.filter((i) => i.type === 'inconsistent_label');
    if (labels.length) {
      insights.push({
        type: 'consistency',
        severity: 'medium',
        category: 'Data Consistency',
        title: 'Inconsistent labels detected',
        detail: `${labels.length} columns have inconsistent casing/formatting of the same values.`,
        priority: 3,
        affectedFile: file.fileName,
        actionable: true,
        action: 'normalize_case',
        fixable: true,
      });
    }

    const empty = issues.filter((i) => i.type === 'empty_rows' || i.type === 'empty_column_header');
    if (empty.length) {
      const totalEmpty = empty.reduce((a, i) => a + (i.impact || 1), 0);
      insights.push({
        type: 'structure',
        severity: 'low',
        category: 'Data Structure',
        title: 'Empty rows or columns found',
        detail: `${totalEmpty} empty rows or columns detected. These add noise to the data.`,
        priority: 4,
        affectedFile: file.fileName,
        actionable: true,
        action: 'remove_empty',
        fixable: true,
      });
    }

    if (issues.filter((i) => i.type === 'type_mismatch').length) {
      insights.push({
        type: 'type_mismatch',
        severity: 'medium',
        category: 'Data Types',
        title: 'Column type mismatches',
        detail: `Some values in numeric/date columns don't match the expected type. This can cause calculation errors.`,
        priority: 3,
        affectedFile: file.fileName,
        actionable: true,
        action: 'review_types',
        fixable: false,
      });
    }

    const dateIssues = issues.filter((i) => i.type === 'date_format');
    if (dateIssues.length) {
      insights.push({
        type: 'date_format',
        severity: 'low',
        category: 'Data Format',
        title: 'Date format inconsistencies',
        detail: `${dateIssues.length} columns have dates in non-standard formats. Standardize to ISO dates.`,
        priority: 4,
        affectedFile: file.fileName,
        actionable: true,
        action: 'standardize_dates',
        fixable: false,
      });
    }

    return insights;
  }

  generateCrossFileInsights(scannedFiles) {
    const insights = [];

    if (scannedFiles.length < 2) return insights;

    const conflicts = scannedFiles
      .flatMap((f) => f.issues || [])
      .filter((i) => i.type === 'cross_file_conflict');

    if (conflicts.length) {
      const totalConflicts = conflicts.reduce((a, i) => a + (i.affectedCount || 0), 0);
      insights.push({
        type: 'conflict',
        severity: 'critical',
        category: 'Data Integration',
        title: 'Data conflicts across files',
        detail: `${totalConflicts} conflicting rows found across files with matching keys. Review before merging.`,
        priority: 1,
        actionable: true,
        action: 'resolve_conflicts',
        fixable: false,
      });
    }

    const relationships = scannedFiles
      .flatMap((f) => f.issues || [])
      .filter((i) => i.type === 'potential_relationship');

    if (relationships.length) {
      const rels = [...new Set(relationships.map((r) => `${r.relatedColumn1}↔${r.relatedColumn2} (${r.relatedFile})`))];
      insights.push({
        type: 'relationship',
        severity: 'info',
        category: 'Data Relationships',
        title: 'Cross-file relationships discovered',
        detail: `${relationships.length} potential relationships detected: ${rels.slice(0, 3).join('; ')}.`,
        priority: 4,
        actionable: true,
        action: 'review_relationships',
        fixable: false,
      });
    }

    return insights;
  }

  generateConsistencyInsights(scannedFiles, existingData) {
    const insights = [];
    const tables = ['OccupancyDay', 'SourceDay', 'GrossRevenueDay', 'PaymentDay'];

    scannedFiles.forEach((file) => {
      const headers = file.headers || [];
      const rows = file.rows || [];

      tables.forEach((table) => {
        if (existingData[table] && Array.isArray(existingData[table])) {
          const existing = existingData[table];
          if (!existing.length) return;

          const existingDates = new Set(
            existing.map((r) => (typeof r.date === 'string' ? r.date.slice(0, 10) : String(r.date).slice(0, 10)))
          );

          const dateColIdx = headers.findIndex(
            (h) => String(h).toLowerCase().includes('date') || String(h).toLowerCase().includes('day')
          );

          if (dateColIdx === -1) return;

          const fileDates = new Set();
          let overlap = 0;
          rows.forEach((row) => {
            const val = String(row[dateColIdx] || '').trim();
            if (val) {
              const iso = convertDate(val);
              if (isIsoDate(iso)) {
                const d = iso.slice(0, 10);
                fileDates.add(d);
                if (existingDates.has(d)) overlap += 1;
              }
            }
          });

          if (overlap > 0) {
            insights.push({
              type: 'overlap_warning',
              severity: 'high',
              category: 'Data Consistency',
              title: `Potential duplicate dates with existing ${table} data`,
              detail: `${overlap} dates in this file already exist in the ${table} table. Import will skip these dates unless you force overwrite.`,
              priority: 2,
              affectedFile: file.fileName,
              actionable: true,
              action: 'review_overlap',
              fixable: false,
            });
          }
        }
      });
    });

    return insights;
  }

  generatePropertyLevelInsights(scannedFiles, propertyContext) {
    const insights = [];
    const propertyId = propertyContext.propertyId;

    if (!propertyId || !scannedFiles.length) return insights;

    const filesForProperty = scannedFiles.filter(
      (f) => !f.propertyId || f.propertyId === propertyId
    );

    if (filesForProperty.length === 0) return insights;

    const allHeaders = new Set();
    filesForProperty.forEach((f) => {
      (f.headers || []).forEach((h) => allHeaders.add(h));
    });

    const expectedColumns = ['Date', 'Total Rooms', 'Rooms Sold', 'Room Revenue', 'Total Revenue'];
    const missingCols = expectedColumns.filter((c) => !allHeaders.has(c) && ![...allHeaders].some((h) => h.toLowerCase() === c.toLowerCase()));

    if (missingCols.length === expectedColumns.length) {
      insights.push({
        type: 'structure',
        severity: 'medium',
        category: 'Property Data',
        title: 'Missing standard occupancy columns',
        detail: `Expected columns like ${expectedColumns.join(', ')} not found. Property data may be incomplete.`,
        priority: 3,
        actionable: true,
        action: 'view_required_columns',
        fixable: false,
      });
    }

    const avgHealth =
      filesForProperty.reduce((sum, f) => sum + (f.healthScore?.score || 100), 0) / filesForProperty.length;

    if (avgHealth < 70) {
      insights.push({
        type: 'health',
        severity: 'high',
        category: 'Property Data',
        title: `Low data health for property: ${propertyContext.propertyName || propertyId}`,
        detail: `Average data health score across ${filesForProperty.length} files is ${avgHealth.toFixed(0)}/100.`,
        priority: 2,
        actionable: true,
        action: 'view_health_trends',
        fixable: false,
      });
    }

    return insights;
  }

  generateAutomationRule(rule) {
    const { trigger, action, conditions } = rule;
    return {
      id: `rule_${Date.now()}`,
      name: rule.name || 'Auto-cleanup rule',
      enabled: true,
      trigger,
      conditions: conditions || [],
      action,
      createdAt: new Date().toISOString(),
      runCount: 0,
      lastRun: null,
      lastResult: null,
    };
  }

  evaluateAutomationRule(rule, scannedFile) {
    const { conditions, action } = rule;
    let triggered = false;

    conditions.forEach((cond) => {
      if (cond.type === 'health_below') {
        if ((scannedFile.healthScore?.score || 100) < cond.threshold) triggered = true;
      }
      if (cond.type === 'issues_above') {
        if ((scannedFile.issues || []).length > cond.threshold) triggered = true;
      }
      if (cond.type === 'duplicate_count_above') {
        const dups = (scannedFile.issues || []).filter((i) => i.type === 'duplicate_row');
        const total = dups.reduce((a, i) => a + (i.impact || 0), 0);
        if (total > cond.threshold) triggered = true;
      }
    });

    if (triggered) {
      return {
        ruleId: rule.id,
        ruleName: rule.name,
        file: scannedFile.fileName,
        action,
        executedAt: new Date().toISOString(),
        result: 'pending',
      };
    }

    return null;
  }

  suggestSmartFixes(scannedFile) {
    const suggestions = [];
    const issues = scannedFile.issues || [];

    const fixableIssues = issues.filter((i) => i.applyAutoFix);
    if (fixableIssues.length) {
      suggestions.push({
        id: 'fix_duplicates',
        name: 'Remove all duplicate rows',
        description: `${fixableIssues.filter((i) => i.type === 'duplicate_row').length} groups of duplicates can be removed`,
        impact: fixableIssues.filter((i) => i.type === 'duplicate_row').reduce((a, i) => a + (i.impact || 0), 0),
        confidence: 0.95,
        action: 'remove_duplicates',
        autoApplyable: true,
      });

      suggestions.push({
        id: 'fix_labels',
        name: 'Normalize inconsistent labels',
        description: `${fixableIssues.filter((i) => i.type === 'inconsistent_label').length} columns need case normalization`,
        impact: fixableIssues.filter((i) => i.type === 'inconsistent_label').length,
        confidence: 0.9,
        action: 'normalize_case',
        autoApplyable: true,
      });
    }

    const structuralIssues = issues.filter(
      (i) => i.type === 'empty_rows' || i.type === 'empty_column_header'
    );
    if (structuralIssues.length) {
      suggestions.push({
        id: 'fix_structure',
        name: 'Remove empty rows',
        description: `${structuralIssues.filter((i) => i.type === 'empty_rows').length} empty row groups to clean`,
        impact: structuralIssues.filter((i) => i.type === 'empty_rows').reduce((a, i) => a + (i.impact || 0), 0),
        confidence: 0.98,
        action: 'remove_empty_rows',
        autoApplyable: true,
      });
    }

    const outlierIssues = issues.filter((i) => i.type === 'outlier');
    if (outlierIssues.length) {
      suggestions.push({
        id: 'flag_outliers',
        name: 'Flag outlier values for review',
        description: `${outlierIssues.length} columns contain outliers`,
        impact: 0,
        confidence: 0.85,
        action: 'flag_outliers',
        autoApplyable: false,
        reason: 'Requires human review to confirm data validity',
      });
    }

    const typeIssues = issues.filter((i) => i.type === 'type_mismatch');
    if (typeIssues.length) {
      suggestions.push({
        id: 'fix_types',
        name: 'Fix column type mismatches',
        description: `${typeIssues.length} columns have mixed types`,
        impact: 0,
        confidence: 0.7,
        action: 'review_types',
        autoApplyable: false,
        reason: 'Cannot automatically determine correct type',
      });
    }

    return suggestions;
  }

  generateDataHealthTrend(history) {
    if (!history || !history.length) {
      return { trend: 'stable', description: 'No history available yet', data: [] };
    }

    const sorted = [...history].sort((a, b) => new Date(a.scannedAt).getTime() - new Date(b.scannedAt).getTime());
    const data = sorted.map((h) => ({
      date: new Date(h.scannedAt).toISOString().slice(0, 10),
      score: h.healthScore?.score || 100,
      issueCount: (h.issues || []).length,
    }));

    if (data.length < 2) return { trend: 'stable', description: 'Insufficient history', data };

    const first = data[0].score;
    const last = data[data.length - 1].score;
    const diff = last - first;

    let trend, description;
    if (diff > 10) {
      trend = 'improving';
      description = `Data health improving: +${diff} points`;
    } else if (diff < -10) {
      trend = 'declining';
      description = `Data health declining: ${diff} points`;
    } else {
      trend = 'stable';
      description = 'Data health is stable';
    }

    return { trend, description, data };
  }
}

function convertDate(s) {
  if (!s) return '';
  s = String(s).trim();
  const m1 = s.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{2,4})$/);
  if (m1) {
    const MONTH_MAP = {
      jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
      jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
    };
    const day = m1[1].padStart(2, '0');
    const mon = MONTH_MAP[m1[2].toLowerCase()];
    let year = m1[3];
    if (year.length === 2) year = '20' + year;
    if (mon) return `${year}-${mon}-${day}`;
  }
  const m2 = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m2) return `${m2[1]}-${m2[2]}-${m2[3]}`;
  const m3 = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (m3) {
    let year = m3[3];
    if (year.length === 2) year = '20' + year;
    return `${year}-${m3[1].padStart(2, '0')}-${m3[2].padStart(2, '0')}`;
  }
  const m4 = s.match(/^([A-Za-z]{3})\s+(\d{1,2}),\s+(\d{4})$/);
  if (m4) {
    const MONTH_MAP = {
      jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
      jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
    };
    const mon = MONTH_MAP[m4[1].toLowerCase()];
    if (mon) return `${m4[3]}-${mon}-${m4[2].padStart(2, '0')}`;
  }
  return s;
}

function isIsoDate(s) {
  return /^\d{4}-\d{2}-\d{2}/.test(String(s || ''));
}

export default AIInsightsEngine;
