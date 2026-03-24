export type BackendMode = 'incoming' | 'outgoing';

export type BackendQuery = {
  mode: BackendMode;
  filePath: string;
  line: number;
  character: number;
  workspaceRoot?: string;
  mcpUrl?: string;
};

export type BackendSystemNodeKind =
  | 'api'
  | 'hw_interrupt'
  | 'sw_thread'
  | 'hw_ring'
  | 'signal'
  | 'interface'
  | 'component'
  | 'timer'
  | 'work_queue'
  | 'unknown';

export type BackendConnectionKind =
  | 'api_call'
  | 'interface_registration'
  | 'sw_thread_comm'
  | 'hw_interrupt'
  | 'hw_ring'
  | 'ring_signal'
  | 'event'
  | 'timer_callback'
  | 'deferred_work'
  | 'debugfs_op'
  | 'ioctl_dispatch'
  | 'ring_completion'
  | 'custom';

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
      connectionKind?: BackendConnectionKind;
      viaRegistrationApi?: string;
    }>;
    calls?: Array<{
      callee: string;
      filePath: string;
      lineNumber: number;
      symbolKind?: number;
      connectionKind?: BackendConnectionKind;
      viaRegistrationApi?: string;
    }>;
    /** Structured system nodes from mediatedPaths (Gate G8) */
    systemNodes?: Array<{
      id: string;
      name: string;
      kind: BackendSystemNodeKind;
      filePath?: string;
      lineNumber?: number;
      symbolKind?: number;
      metadata?: Record<string, string | number | boolean | null>;
    }>;
    /** Structured system links from mediatedPaths (Gate G8) */
    systemLinks?: Array<{
      fromId: string;
      toId: string;
      kind: BackendConnectionKind;
      direction?: 'in' | 'out' | 'bi';
      metadata?: Record<string, string | number | boolean | null>;
    }>;
  }> | null;
};
