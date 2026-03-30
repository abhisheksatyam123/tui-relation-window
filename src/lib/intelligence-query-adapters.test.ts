/**
 * Unit tests for queryResultToLogRows and queryResultToStructWriterRows adapters.
 *
 * Close signal: adapters correctly map IntelligenceQueryResult nodes to
 * LogRow[] / StructWriterRow[] with all required fields and graceful handling
 * of missing/optional fields.
 */
import { describe, expect, test } from 'bun:test';
import { queryResultToLogRows, queryResultToStructWriterRows } from './intelligence-query-adapters';
import type { IntelligenceQueryResult } from './clangd-mcp-client';

function makeResult(
  status: IntelligenceQueryResult['status'],
  nodes: Array<Record<string, unknown>>,
): IntelligenceQueryResult {
  return { status, data: { nodes, edges: [] }, raw: '' };
}

describe('queryResultToLogRows', () => {
  test('maps all fields from a full log node', () => {
    const result = makeResult('hit', [
      {
        level: 'ERROR',
        template: 'Failed to connect: %s',
        subsystem: 'wlan_conn',
        file_path: '/src/conn.c',
        line: 42,
        confidence: 0.95,
      },
    ]);

    const rows = queryResultToLogRows(result);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.level).toBe('ERROR');
    expect(rows[0]?.template).toBe('Failed to connect: %s');
    expect(rows[0]?.subsystem).toBe('wlan_conn');
    expect(rows[0]?.filePath).toBe('/src/conn.c');
    expect(rows[0]?.line).toBe(42);
    expect(rows[0]?.confidence).toBe(0.95);
  });

  test('falls back to UNKNOWN for missing level', () => {
    const result = makeResult('hit', [{ template: 'some log', confidence: 0.5 }]);
    const rows = queryResultToLogRows(result);
    expect(rows[0]?.level).toBe('UNKNOWN');
  });

  test('falls back to empty string for missing template', () => {
    const result = makeResult('hit', [{ level: 'INFO', confidence: 0.8 }]);
    const rows = queryResultToLogRows(result);
    expect(rows[0]?.template).toBe('');
  });

  test('omits subsystem when not a string', () => {
    const result = makeResult('hit', [{ level: 'DEBUG', template: 'msg', subsystem: 42, confidence: 0.1 }]);
    const rows = queryResultToLogRows(result);
    expect(rows[0]?.subsystem).toBeUndefined();
  });

  test('omits filePath when not a string', () => {
    const result = makeResult('hit', [{ level: 'INFO', template: 'msg', file_path: null, confidence: 0.1 }]);
    const rows = queryResultToLogRows(result);
    expect(rows[0]?.filePath).toBeUndefined();
  });

  test('omits line when not a number', () => {
    const result = makeResult('hit', [{ level: 'INFO', template: 'msg', line: '10', confidence: 0.1 }]);
    const rows = queryResultToLogRows(result);
    expect(rows[0]?.line).toBeUndefined();
  });

  test('falls back to 0 confidence when missing', () => {
    const result = makeResult('hit', [{ level: 'WARN', template: 'msg' }]);
    const rows = queryResultToLogRows(result);
    expect(rows[0]?.confidence).toBe(0);
  });

  test('returns empty array for empty nodes', () => {
    const result = makeResult('not_found', []);
    expect(queryResultToLogRows(result)).toEqual([]);
  });

  test('maps multiple rows', () => {
    const result = makeResult('hit', [
      { level: 'INFO', template: 'msg1', confidence: 0.9 },
      { level: 'WARN', template: 'msg2', confidence: 0.7 },
      { level: 'ERROR', template: 'msg3', confidence: 0.5 },
    ]);
    const rows = queryResultToLogRows(result);
    expect(rows).toHaveLength(3);
    expect(rows[0]?.level).toBe('INFO');
    expect(rows[1]?.level).toBe('WARN');
    expect(rows[2]?.level).toBe('ERROR');
  });
});

describe('queryResultToStructWriterRows', () => {
  test('maps all fields from a full struct writer node', () => {
    const result = makeResult('hit', [
      {
        writer: 'init_wlan_cfg',
        target: 'wlan_cfg_t',
        edge_kind: 'write',
        confidence: 0.88,
        derivation: 'static_analysis',
        current_api_runtime_structure_access_path_expression: 'cfg->field',
      },
    ]);

    const rows = queryResultToStructWriterRows(result);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.writer).toBe('init_wlan_cfg');
    expect(rows[0]?.target).toBe('wlan_cfg_t');
    expect(rows[0]?.edgeKind).toBe('write');
    expect(rows[0]?.confidence).toBe(0.88);
    expect(rows[0]?.derivation).toBe('static_analysis');
    expect(rows[0]?.accessPath).toBe('cfg->field');
  });

  test('falls back to api-centric field names when short names missing', () => {
    const result = makeResult('hit', [
      {
        current_structure_runtime_writer_api_name: 'setup_fn',
        current_structure_runtime_target_structure_name: 'my_struct',
        current_structure_runtime_structure_operation_type_classification: 'partial_write',
        current_structure_runtime_structure_operation_confidence_score: 0.75,
        current_structure_runtime_relation_derivation_source: 'llm',
      },
    ]);

    const rows = queryResultToStructWriterRows(result);
    expect(rows[0]?.writer).toBe('setup_fn');
    expect(rows[0]?.target).toBe('my_struct');
    expect(rows[0]?.edgeKind).toBe('partial_write');
    expect(rows[0]?.confidence).toBe(0.75);
    expect(rows[0]?.derivation).toBe('llm');
  });

  test('omits accessPath when not a string', () => {
    const result = makeResult('hit', [
      {
        writer: 'fn',
        target: 'st',
        edge_kind: 'write',
        confidence: 0.5,
        derivation: 'static',
        current_api_runtime_structure_access_path_expression: 123,
      },
    ]);
    const rows = queryResultToStructWriterRows(result);
    expect(rows[0]?.accessPath).toBeUndefined();
  });

  test('falls back to empty strings for missing required fields', () => {
    const result = makeResult('hit', [{}]);
    const rows = queryResultToStructWriterRows(result);
    expect(rows[0]?.writer).toBe('');
    expect(rows[0]?.target).toBe('');
    expect(rows[0]?.edgeKind).toBe('');
    expect(rows[0]?.derivation).toBe('');
    expect(rows[0]?.confidence).toBe(0);
  });

  test('returns empty array for empty nodes', () => {
    const result = makeResult('not_found', []);
    expect(queryResultToStructWriterRows(result)).toEqual([]);
  });
});
