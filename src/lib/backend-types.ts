export type BackendMode = 'incoming' | 'outgoing';

export type BackendQuery = {
  mode: BackendMode;
  filePath: string;
  line: number;
  character: number;
  workspaceRoot?: string;
  mcpUrl?: string;
};

export type BackendRelationPayload = {
  mode: BackendMode;
  provider: string;
  result: Record<string, {
    symbolKind?: number;
    filePath?: string;
    lineNumber?: number;
    character?: number;
    calledBy?: Array<{
      caller: string;
      filePath: string;
      lineNumber: number;
      symbolKind?: number;
      connectionKind?: 'api_call' | 'interface_registration';
    }>;
    calls?: Array<{
      callee: string;
      filePath: string;
      lineNumber: number;
      symbolKind?: number;
      connectionKind?: 'api_call' | 'interface_registration';
      viaRegistrationApi?: string;
    }>;
  }> | null;
};
