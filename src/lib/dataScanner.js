import { db } from '@/api/base44Client';
import { parseCsvText, convertDate, isIsoDate, parseAmount } from '@/lib/csvParser';

export class DataScanner {
  constructor() {
    this.healthHistory = [];
    this.scanCache = new Map();
  }

  async loadAllFiles() {
    // Scoped read. This walks every uploaded report and hands back its parsed
    // preview rows, so a raw table read exposed other properties' report contents.
    const allRows = await db.entities.UploadedReport.list();
    return allRows.map((r) => ({
      id: r.id,
      name: r.file_name,
      type: r.report_type,
      propertyId: r.property_id,
      propertyName: r.property_name,
      rows: r.raw_rows || [],
      rowCount: r.rows_imported,
      date: r.created_date,
    }));
  }

  parseFileContent(text, filename) {
    if (!/\.csv$/i.test(filename) && !text.includes('\n')) {
      return { headers: [], rows: [], columns: [] };
    }
    const rawRows = parseCsvText(text);
    if (rawRows.length < 1) return { headers: [], rows: [], columns: [] };
    const headers = rawRows[0].map((h) => h.trim());
    const dataRows = rawRows.slice(1).filter(
      (r) => r.length > 0 && r.some((c) => c !== '')
    );
    return { headers, rows: dataRows, columns: headers };
  }

  detectDuplicates(rows, _headers) {
    if (!rows.length) return [];
    const seen = new Map();
    const duplicateGroups = [];

    rows.forEach((row, idx) => {
      const key = JSON.stringify(row.map((v) => (v == null ? '' : String(v).trim().toLowerCase())));
      if (seen.has(key)) {
        const existingIdx = seen.get(key);
        const foundGroup = duplicateGroups.find(
          (g) => g.rows.includes(existingIdx)
        );
        if (foundGroup) {
          foundGroup.rows.push(idx);
          foundGroup.count += 1;
        } else {
          duplicateGroups.push({
            rows: [existingIdx, idx],
            count: 2,
            sample: row,
            key,
          });
        }
      } else {
        seen.set(key, idx);
      }
    });

    return duplicateGroups.map((g) => ({
      type: 'duplicate_row',
      severity: 'medium',
      impact: g.count - 1,
      description: `${g.count} identical rows detected (rows ${g.rows.join(', ')})`,
      suggestion: 'Remove duplicate rows; keep the first occurrence',
      affectedRows: g.rows,
      applyAutoFix: true,
      fixAction: 'remove_duplicates',
      fixParams: { keep: 'first' },
    }));
  }

  detectMissingData(rows, headers) {
    if (!rows.length || !headers.length) return [];
    const issues = [];

    headers.forEach((header, colIdx) => {
      if (!header) {
        issues.push({
          type: 'empty_column_header',
          severity: 'low',
          description: `Column ${colIdx + 1} has no header`,
          suggestion: 'Provide a descriptive header for this column',
          affectedColumn: colIdx,
          applyAutoFix: false,
        });
        return;
      }

      let emptyCount = 0;
      rows.forEach((row) => {
        const val = row[colIdx];
        if (val === null || val === undefined || String(val).trim() === '') {
          emptyCount += 1;
        }
      });

      if (emptyCount > 0) {
        const pct = (emptyCount / rows.length) * 100;
        issues.push({
          type: 'missing_values',
          severity: pct > 50 ? 'high' : pct > 20 ? 'medium' : 'low',
          impact: emptyCount,
          description: `${header}: ${emptyCount} missing values (${pct.toFixed(1)}%)`,
          suggestion:
            pct > 50
              ? 'Column is mostly empty — consider removing it or investigate data source'
              : 'Fill missing values or mark as N/A',
          affectedColumn: colIdx,
          affectedHeader: header,
          applyAutoFix: pct < 50,
          fixAction: 'fill_missing',
          fixParams: { column: header, strategy: 'fillna', value: '' },
        });
      }
    });

    const fullyEmptyRows = [];
    rows.forEach((row, idx) => {
      if (row.every((v) => v === null || v === undefined || String(v).trim() === '')) {
        fullyEmptyRows.push(idx);
      }
    });

    if (fullyEmptyRows.length) {
      issues.push({
        type: 'empty_rows',
        severity: 'medium',
        impact: fullyEmptyRows.length,
        description: `${fullyEmptyRows.length} completely empty rows detected`,
        suggestion: 'Remove blank rows',
        affectedRows: fullyEmptyRows,
        applyAutoFix: true,
        fixAction: 'remove_empty_rows',
        fixParams: { rows: fullyEmptyRows },
      });
    }

    return issues;
  }

  detectInconsistencies(rows, headers) {
    if (!rows.length) return [];
    const issues = [];
    const columnTypes = this.inferColumnTypes(rows, headers);

    headers.forEach((header, colIdx) => {
      const type = columnTypes[colIdx];
      if (type === 'empty') return;

      const values = rows.map((r) => String(r[colIdx] || '').trim()).filter((v) => v !== '');
      if (!values.length) return;

      if (type === 'numeric') {
        const numericVals = values.map((v) => parseAmount(v)).filter((n) => n !== null);
        if (numericVals.length !== values.length) {
          const badVals = values.filter((v) => parseAmount(v) === null);
          issues.push({
            type: 'type_mismatch',
            severity: 'medium',
            description: `${header}: ${badVals.length} non-numeric values found`,
            suggestion: `These values look like they should be numbers: ${badVals.slice(0, 5).join(', ')}`,
            affectedColumn: colIdx,
            affectedHeader: header,
            applyAutoFix: false,
          });
        }

        if (numericVals.length >= 3) {
          const stats = this.calcStats(numericVals);
          const outliers = numericVals.filter((v) => {
            if (stats.std === 0) return false;
            const z = Math.abs(v - stats.mean) / stats.std;
            return z > 3;
          });
          if (outliers.length) {
            issues.push({
              type: 'outlier',
              severity: 'medium',
              description: `${header}: ${outliers.length} statistical outliers (z-score > 3)`,
              suggestion: `Outlier values: ${outliers.slice(0, 5).map((v) => v.toFixed(2)).join(', ')}`,
              affectedColumn: colIdx,
              affectedHeader: header,
              outliers: outliers,
              stats: { min: stats.min, max: stats.max, mean: stats.mean, std: stats.std },
              applyAutoFix: false,
            });
          }
        }
      }

      if (type === 'date') {
        const dateVals = values
          .map((v) => convertDate(v))
          .filter((d) => d && isIsoDate(d));
        if (dateVals.length !== values.length) {
          const bad = values.filter((v) => !isIsoDate(convertDate(v)));
          issues.push({
            type: 'date_format',
            severity: 'low',
            description: `${header}: ${bad.length} unparseable dates`,
            suggestion: `Ambiguous date formats: ${bad.slice(0, 5).join(', ')}`,
            affectedColumn: colIdx,
            affectedHeader: header,
            applyAutoFix: false,
          });
        }
      }

      if (type === 'text') {
        const lower = values.map((v) => v.toLowerCase());
        const freq = {};
        lower.forEach((v) => {
          freq[v] = (freq[v] || 0) + 1;
        });

        const casingIssues = [];
        Object.entries(freq).forEach(([val, count]) => {
          if (count > 1) {
            const variants = values.filter((v) => v.toLowerCase() === val);
            const uniqueVariants = [...new Set(variants)];
            if (uniqueVariants.length > 1) {
              casingIssues.push({
                value: val,
                variants: uniqueVariants,
                count,
              });
            }
          }
        });

        if (casingIssues.length) {
          issues.push({
            type: 'inconsistent_label',
            severity: 'medium',
            description: `${header}: ${casingIssues.length} inconsistent label formats`,
            suggestion: casingIssues
              .slice(0, 3)
              .map((c) => `${c.variants.join(' / ')} (${c.count}x)`)
              .join('; '),
            affectedColumn: colIdx,
            affectedHeader: header,
            applyAutoFix: true,
            fixAction: 'normalize_case',
          });
        }
      }
    });

    return issues;
  }

  inferColumnTypes(rows, headers) {
    if (!headers.length) return [];

    return headers.map((header, colIdx) => {
      if (!header) return 'empty';

      const values = rows
        .map((r) => String(r[colIdx] || '').trim())
        .filter((v) => v !== '');

      if (!values.length) return 'empty';

      let numeric = 0;
      let dateLike = 0;

      values.forEach((v) => {
        if (parseAmount(v) !== null) numeric += 1;
        else if (convertDate(v) && isIsoDate(convertDate(v))) dateLike += 1;
      });

      const total = values.length;
      if (numeric / total > 0.8) return 'numeric';
      if (dateLike / total > 0.8) return 'date';
      return 'text';
    });
  }

  calcStats(values) {
    if (!values.length) return { mean: 0, std: 0, min: 0, max: 0 };
    const sum = values.reduce((a, b) => a + b, 0);
    const mean = sum / values.length;
    const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length;
    const std = Math.sqrt(variance);
    return {
      mean,
      std,
      min: Math.min(...values),
      max: Math.max(...values),
    };
  }

  detectConflicts(rows1, rows2, headers1, headers2) {
    if (!headers1.length || !headers2.length) return [];
    const issues = [];

    const commonHeaders = [];
    const used2 = new Set();
    headers1.forEach((h1, i1) => {
      const lower = String(h1).toLowerCase().trim();
      const idx2 = headers2.findIndex((h, i) => !used2.has(i) && String(h).toLowerCase().trim() === lower);
      if (idx2 !== -1) {
        used2.add(idx2);
        commonHeaders.push({ name: h1, idx1: i1, idx2 });
      }
    });

    if (commonHeaders.length === 0) return [];

    const keyCols = commonHeaders.filter((h) => ['date', 'code', 'name', 'id'].some((k) => h.name.toLowerCase().includes(k)));
    if (keyCols.length === 0) return [];

    const map1 = new Map();
    rows1.forEach((row) => {
      const key = keyCols.map((k) => String(row[k.idx1] || '').trim().toLowerCase()).join('|');
      if (key) {
        map1.set(key, row);
      }
    });

    const map2 = new Map();
    rows2.forEach((row) => {
      const key = keyCols.map((k) => String(row[k.idx2] || '').trim().toLowerCase()).join('|');
      if (key) {
        map2.set(key, row);
      }
    });

    const conflicts = [];
    const allKeys = new Set([...map1.keys(), ...map2.keys()]);

    allKeys.forEach((key) => {
      const row1 = map1.get(key);
      const row2 = map2.get(key);

      if (row1 && row2) {
        const diffs = [];
        commonHeaders.forEach((h) => {
          const v1 = row1[h.idx1];
          const v2 = row2[h.idx2];
          if (String(v1).trim().toLowerCase() !== String(v2).trim().toLowerCase()) {
            diffs.push({ column: h.name, value1: v1, value2: v2 });
          }
        });

        if (diffs.length) {
          conflicts.push({
            key,
            diffs,
          });
        }
      }
    });

    if (conflicts.length) {
      issues.push({
        type: 'cross_file_conflict',
        severity: 'high',
        description: `${conflicts.length} conflicting rows found across files for matching keys`,
        suggestion: 'Review conflicting values and decide which file data to trust',
        affectedCount: conflicts.length,
        conflicts: conflicts.slice(0, 50),
        applyAutoFix: false,
      });
    }

    return issues;
  }

  detectRelationships(rows, headers, otherDatasets) {
    if (!headers.length || !rows.length || !otherDatasets?.length) return [];

    const relationships = [];
    const potentialKeys = headers
      .map((h, i) => ({ name: h, idx: i }))
      .filter((h) =>
        ['date', 'date', 'day', 'month', 'year', 'code', 'source', 'id', 'name', 'type', 'category']
          .some((kw) => String(h.name).toLowerCase().includes(kw))
      );

    potentialKeys.forEach((key) => {
      const vals1 = [...new Set(rows.map((r) => String(r[key.idx] || '').trim().toLowerCase()).filter((v) => v))];

      otherDatasets.forEach((other) => {
        if (!other.headers || !other.rows) return;
        const otherKeyCandidates = other.headers
          .map((h, i) => ({ name: h, idx: i }))
          .filter((h) => String(h.name).toLowerCase().includes(String(key.name).toLowerCase().replace(/_/g, '')));

        if (otherKeyCandidates.length === 0) return;

        otherKeyCandidates.forEach((otherKey) => {
          const vals2 = [...new Set(other.rows.map((r) => String(r[otherKey.idx] || '').trim().toLowerCase()).filter((v) => v))];

          const intersection = vals1.filter((v) => vals2.includes(v));
          const union = [...new Set([...vals1, ...vals2])];
          const overlap = union.length > 0 ? intersection.length / union.length : 0;

          if (overlap > 0.05 && intersection.length >= 2) {
            relationships.push({
              type: 'potential_relationship',
              severity: 'info',
              description: `Strong relationship: ${key.name} matches ${intersection.length} values with ${other.name}'s ${otherKey.name} (${(overlap * 100).toFixed(1)}% overlap)`,
              confidence: overlap,
              relatedColumn1: key.name,
              relatedColumn2: otherKey.name,
              relatedFile: other.name,
              matchCount: intersection.length,
            });
          }
        });
      });
    });

    return relationships;
  }

  calculateHealthScore(issues, rows, headers) {
    if (!rows.length) return { score: 100, grade: 'A', breakdown: {} };

    const critical = issues.filter((i) => i.severity === 'critical').length;
    const high = issues.filter((i) => i.severity === 'high').length;
    const medium = issues.filter((i) => i.severity === 'medium').length;
    const low = issues.filter((i) => i.severity === 'low').length;

    const totalRows = rows.length;
    const totalCells = totalRows * headers.length;
    const missingRatio = 1 - issues.filter((i) => i.type === 'missing_values').reduce((a, i) => a + i.impact, 0) / totalCells;

    let score = 100;
    score -= critical * 20;
    score -= high * 10;
    score -= medium * 5;
    score -= low * 2;

    if (missingRatio < 0.5) score -= 10;
    else if (missingRatio < 0.8) score -= 5;

    score = Math.max(0, Math.min(100, Math.round(score)));

    const grade = score >= 90 ? 'A' : score >= 80 ? 'B' : score >= 70 ? 'C' : score >= 60 ? 'D' : 'F';

    return {
      score,
      grade,
      breakdown: {
        critical,
        high,
        medium,
        low,
        completeness: `${(missingRatio * 100).toFixed(1)}%`,
        totalIssues: issues.length,
      },
    };
  }

  generateInsights(issues, healthScore, _rows, _headers) {
    const insights = [];

    if (healthScore.score < 50) {
      insights.push({
        type: 'critical',
        title: 'Data quality is critical',
        detail: `Health score of ${healthScore.score}/100 indicates serious data issues. ${healthScore.breakdown.totalIssues} problems found.`,
        priority: 1,
      });
    }

    const dupIssues = issues.filter((i) => i.type === 'duplicate_row');
    if (dupIssues.length) {
      const totalDups = dupIssues.reduce((a, i) => a + i.impact, 0);
      insights.push({
        type: 'duplicate',
        title: 'Duplicate rows detected',
        detail: `${totalDups} duplicate rows found across ${dupIssues.length} groups. This inflates counts and metrics.`,
        priority: 2,
        fixable: true,
        fixAction: 'remove_duplicates',
      });
    }

    const missingIssues = issues.filter((i) => i.type === 'missing_values');
    if (missingIssues.length) {
      const colsWithMissing = missingIssues.map((i) => i.affectedHeader).join(', ');
      insights.push({
        type: 'missing',
        title: 'Missing data detected',
        detail: `${missingIssues.length} columns have missing values. Columns affected: ${colsWithMissing}.`,
        priority: 3,
        fixable: missingIssues.some((i) => i.applyAutoFix),
      });
    }

    const outlierIssues = issues.filter((i) => i.type === 'outlier');
    if (outlierIssues.length) {
      insights.push({
        type: 'outlier',
        title: 'Statistical outliers found',
        detail: `${outlierIssues.length} columns contain outlier values that could skew analysis.`,
        priority: 3,
        fixable: false,
      });
    }

    const conflictIssues = issues.filter((i) => i.type === 'cross_file_conflict');
    if (conflictIssues.length) {
      insights.push({
        type: 'conflict',
        title: 'Data conflicts between files',
        detail: `${conflictIssues[0].affectedCount} rows have conflicting values across files. Manual review required.`,
        priority: 1,
        fixable: false,
      });
    }

    const relations = issues.filter((i) => i.type === 'potential_relationship');
    if (relations.length) {
      insights.push({
        type: 'relationship',
        title: 'File relationships discovered',
        detail: `${relations.length} potential relationships between columns detected. Useful for joins.`,
        priority: 4,
        fixable: false,
      });
    }

    return insights.sort((a, b) => a.priority - b.priority);
  }

  autoFix(rows, headers, issues, fixActions) {
    let result = rows.map((r) => [...r]);
    const fixesApplied = [];
    const fixesSkipped = [];

    issues.forEach((issue) => {
      if (!fixActions.includes(issue.fixAction)) return;
      if (!issue.applyAutoFix) {
        fixesSkipped.push({ issue, reason: 'Not auto-fixable' });
        return;
      }

      switch (issue.fixAction) {
        case 'remove_duplicates': {
          const seen = new Set();
          const removeIndices = new Set();

          issue.affectedRows.forEach((idx) => {
            const key = JSON.stringify(result[idx].map((v) => (v == null ? '' : String(v).trim().toLowerCase())));
            if (seen.has(key)) {
              removeIndices.add(idx);
            } else {
              seen.add(key);
            }
          });

          result = result.filter((_, idx) => !removeIndices.has(idx));
          fixesApplied.push({ action: 'remove_duplicates', count: removeIndices.size });
          break;
        }

        case 'normalize_case': {
          const colIdx = issue.affectedColumn;
          const vals = result.map((r) => String(r[colIdx] || '').trim());
          const freq = {};
          vals.forEach((v) => {
            const lc = v.toLowerCase();
            freq[lc] = (freq[lc] || 0) + 1;
          });

          const mode = {};
          Object.entries(freq).forEach(([lc, count]) => {
            if (!mode[lc] || freq[lc] > mode[lc].count) {
              mode[lc] = { count, original: vals.find((v) => v.toLowerCase() === lc) };
            }
          });

          result = result.map((row) => {
            const lc = String(row[colIdx] || '').trim().toLowerCase();
            if (lc && mode[lc]) {
              row[colIdx] = mode[lc].original;
            }
            return row;
          });
          fixesApplied.push({ action: 'normalize_case', column: issue.affectedHeader });
          break;
        }

        case 'fill_missing': {
          const colIdx = issue.affectedColumn;
          const strategy = issue.fixParams?.strategy;
          if (strategy === 'fillna') {
            const fillVal = issue.fixParams.value || '';
            let filled = 0;
            result = result.map((row) => {
              if (String(row[colIdx] || '').trim() === '') {
                row[colIdx] = fillVal;
                filled += 1;
              }
              return row;
            });
            if (filled > 0) {
              fixesApplied.push({ action: 'fill_missing', column: issue.affectedHeader, count: filled });
            }
          }
          break;
        }

        case 'remove_empty_rows': {
          const removeIndices = new Set(issue.affectedRows || []);
          result = result.filter((_, idx) => !removeIndices.has(idx));
          fixesApplied.push({ action: 'remove_empty_rows', count: issue.affectedRows?.length || 0 });
          break;
        }
      }
    });

    return {
      cleanedRows: result,
      fixesApplied,
      fixesSkipped,
      originalCount: rows.length,
      cleanedCount: result.length,
      reduction: ((rows.length - result.length) / rows.length * 100).toFixed(1),
    };
  }

  smartMatch(rows1, rows2, keyCols1, keyCols2, threshold = 0.7) {
    if (!rows1.length || !rows2.length || !keyCols1.length || !keyCols2.length) {
      return { matches: [], unmatched1: rows1.map((r, i) => i), unmatched2: rows2.map((r, i) => i) };
    }

    const fuzzyMatch = (a, b) => {
      const s1 = String(a || '').toLowerCase().trim();
      const s2 = String(b || '').toLowerCase().trim();
      if (s1 === s2) return 1;
      if (s1.includes(s2) || s2.includes(s1)) return 0.85;
      const d = this.levenshtein(s1, s2);
      const maxLen = Math.max(s1.length, s2.length);
      if (maxLen === 0) return 1;
      return 1 - d / maxLen;
    };

    const getKey = (row, cols) => cols.map((c) => String(row[c] || '').trim()).join('|').toLowerCase();

    const map2 = new Map();
    rows2.forEach((row, idx) => {
      map2.set(getKey(row, keyCols2), idx);
    });

    const matches = [];
    const unmatched1 = [];
    const unmatched2 = new Set(rows2.keys());

    rows1.forEach((row1, idx1) => {
      const key1 = getKey(row1, keyCols1);
      let bestScore = 0;
      let bestIdx2 = -1;

      for (const [key2, idx2] of map2.entries()) {
        let score = 0;
        const vals1 = keyCols1.map((c) => String(row1[c] || ''));
        const vals2 = keyCols2.map((c) => String(rows2[idx2][c] || ''));

        if (keyCols1.length === keyCols2.length) {
          vals1.forEach((v1, i) => {
            score += fuzzyMatch(v1, vals2[i]);
          });
          score /= keyCols1.length;
        } else {
          score = fuzzyMatch(key1, key2);
        }

        if (score > bestScore) {
          bestScore = score;
          bestIdx2 = idx2;
        }
      }

      if (bestScore >= threshold && bestIdx2 !== -1) {
        matches.push({
          row1: idx1,
          row2: bestIdx2,
          score: bestScore,
          values1: keyCols1.map((c) => row1[c]),
          values2: keyCols2.map((c) => rows2[bestIdx2][c]),
        });
        unmatched2.delete(bestIdx2);
      } else {
        unmatched1.push(idx1);
      }
    });

    return {
      matches,
      unmatched1,
      unmatched2: [...unmatched2],
    };
  }

  levenshtein(s1, s2) {
    if (s1 === s2) return 0;
    const len1 = s1.length;
    const len2 = s2.length;
    if (len1 === 0) return len2;
    if (len2 === 0) return len1;

    const matrix = [];
    for (let i = 0; i <= len1; i++) matrix[i] = [i];
    for (let j = 0; j <= len2; j++) matrix[0][j] = j;

    for (let i = 1; i <= len1; i++) {
      for (let j = 1; j <= len2; j++) {
        const cost = s1[i - 1] === s2[j - 1] ? 0 : 1;
        matrix[i][j] = Math.min(
          matrix[i - 1][j] + 1,
          matrix[i][j - 1] + 1,
          matrix[i - 1][j - 1] + cost
        );
      }
    }
    return matrix[len1][len2];
  }

  // `propertyId` is required, not optional. ScanResult is a property-scoped table,
  // so a row written without one belongs to no property and every scoped read
  // misses it — the row would be silently invisible rather than loudly refused.
  async saveScanResult(fileId, scanResult, propertyId) {
    try {
      await db.entities.ScanResult.create({
        file_id: fileId,
        property_id: propertyId,
        ...scanResult,
        scanned_at: new Date().toISOString(),
      });
    } catch (e) {
      console.warn('[DataScanner] Could not save scan result:', e.message);
    }
  }

  async getScanHistory() {
    try {
      return await db.entities.ScanResult.list();
    } catch {
      return [];
    }
  }

  generateReport(scanResults) {
    const report = {
      generatedAt: new Date().toISOString(),
      filesScanned: scanResults.length,
      totalRows: 0,
      summary: {
        totalIssues: 0,
        bySeverity: { critical: 0, high: 0, medium: 0, low: 0, info: 0 },
        byType: {},
      },
      files: [],
    };

    scanResults.forEach((scan) => {
      report.totalRows += scan.rowCount || 0;
      const issues = scan.issues || [];
      report.summary.totalIssues += issues.length;

      issues.forEach((issue) => {
        report.summary.bySeverity[issue.severity] = (report.summary.bySeverity[issue.severity] || 0) + 1;
        report.summary.byType[issue.type] = (report.summary.byType[issue.type] || 0) + 1;
      });

      report.files.push({
        name: scan.fileName,
        rowCount: scan.rowCount,
        healthScore: scan.healthScore?.score || 0,
        grade: scan.healthScore?.grade || 'F',
        issueCount: issues.length,
        topIssues: issues
          .sort((a, b) => (this.severityRank(b.severity) - this.severityRank(a.severity)))
          .slice(0, 5),
      });
    });

    return report;
  }

  severityRank(sev) {
    return { critical: 0, high: 1, medium: 2, low: 3, info: 4 }[sev] ?? 5;
  }

  fullScan(rows, headers, fileName, otherDatasets = []) {
    const issues = [];

    issues.push(...this.detectDuplicates(rows, headers));
    issues.push(...this.detectMissingData(rows, headers));
    issues.push(...this.detectInconsistencies(rows, headers));

    if (otherDatasets.length) {
      otherDatasets.forEach((other) => {
        if (other.fileName === fileName) return;
        issues.push(...this.detectConflicts(rows, headers, other.rows, other.headers));
      });

      issues.push(...this.detectRelationships(rows, headers, otherDatasets));
    }

    const healthScore = this.calculateHealthScore(issues, rows, headers);
    const insights = this.generateInsights(issues, healthScore, rows, headers);

    return {
      fileName,
      headers,
      rows,
      rowCount: rows.length,
      issues,
      healthScore,
      insights,
      scannedAt: new Date().toISOString(),
    };
  }
}

export default new DataScanner();
