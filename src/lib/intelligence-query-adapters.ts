import type { IntelligenceQueryResult } from './clangd-mcp-client';

export type LogRow = {
  level: string;
  template: string;
  subsystem?: string;
  filePath?: string;
  line?: number;
  confidence: number;
};

export type StructWriterRow = {
  writer: string;
  target: string;
  edgeKind: string;
  confidence: number;
  derivation: string;
  accessPath?: string;
};

/**
 * Convert find_api_logs / find_api_logs_by_level result into LogRow[].
 */
export function queryResultToLogRows(result: IntelligenceQueryResult): LogRow[] {
  return result.data.nodes.map((n) => ({
    level: String(n['level'] ?? 'UNKNOWN'),
    template: String(n['template'] ?? ''),
    subsystem: typeof n['subsystem'] === 'string' ? n['subsystem'] : undefined,
    filePath: typeof n['file_path'] === 'string' ? n['file_path'] : undefined,
    line: typeof n['line'] === 'number' ? n['line'] : undefined,
    confidence: Number(n['confidence'] ?? 0),
  }));
}

/**
 * Convert find_struct_writers / current_structure_runtime_writers_of_structure result into StructWriterRow[].
 */
export function queryResultToStructWriterRows(result: IntelligenceQueryResult): StructWriterRow[] {
  return result.data.nodes.map((n) => ({
    writer: String(n['writer'] ?? n['current_structure_runtime_writer_api_name'] ?? ''),
    target: String(n['target'] ?? n['current_structure_runtime_target_structure_name'] ?? ''),
    edgeKind: String(n['edge_kind'] ?? n['current_structure_runtime_structure_operation_type_classification'] ?? ''),
    confidence: Number(n['confidence'] ?? n['current_structure_runtime_structure_operation_confidence_score'] ?? 0),
    derivation: String(n['derivation'] ?? n['current_structure_runtime_relation_derivation_source'] ?? ''),
    accessPath: typeof n['current_api_runtime_structure_access_path_expression'] === 'string'
      ? n['current_api_runtime_structure_access_path_expression']
      : undefined,
  }));
}
