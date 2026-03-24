export type QueryMode = 'incoming' | 'outgoing';
export type RelationMode = QueryMode | 'both';

export type SystemNodeKind =
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

export type SystemConnectionKind =
  | 'api_call'
  | 'hw_interrupt'
  | 'sw_thread_comm'
  | 'hw_ring'
  | 'ring_signal'
  | 'interface_registration'
  | 'event'
  | 'timer_callback'
  | 'deferred_work'
  | 'debugfs_op'
  | 'ioctl_dispatch'
  | 'ring_completion'
  | 'custom';

export type CallerNode = {
  caller: string;
  filePath: string;
  lineNumber: number;
  symbolKind?: number;
  connectionKind?: SystemConnectionKind;
};

export type CalleeNode = {
  callee: string;
  filePath: string;
  lineNumber: number;
  symbolKind?: number;
  connectionKind?: SystemConnectionKind;
  viaRegistrationApi?: string;
};

export type RelationRootNode = {
  symbolKind?: number;
  filePath?: string;
  lineNumber?: number;
  character?: number;
  calledBy?: CallerNode[];
  calls?: CalleeNode[];
  systemNodes?: Array<{
    id: string;
    name: string;
    kind: SystemNodeKind;
    filePath?: string;
    lineNumber?: number;
    symbolKind?: number;
    metadata?: Record<string, string | number | boolean | null>;
  }>;
  systemLinks?: Array<{
    fromId: string;
    toId: string;
    kind: SystemConnectionKind;
    direction?: 'in' | 'out' | 'bi';
    metadata?: Record<string, string | number | boolean | null>;
  }>;
};

export type RelationResult = Record<string, RelationRootNode>;

export type FlatRelationItem = {
  id: string;
  label: string;
  filePath: string;
  lineNumber: number;
  relationType: QueryMode;
  symbolKind?: number;
  connectionKind?: SystemConnectionKind;
  viaRegistrationApi?: string;
};

export type RelationPayload = {
  mode: RelationMode;
  provider?: string;
  result: RelationResult | null;
};

export type BridgeIncomingMessage =
  | { type: 'set_data'; payload: RelationPayload }
  | {
      type: 'add_custom_relation';
      payload: {
        relationType: QueryMode;
        label: string;
        filePath: string;
        lineNumber: number;
        symbolKind?: number;
      };
    }
  | { type: 'query_result'; payload: { requestId: string; parentId: string; result: RelationPayload } }
  | { type: 'query_error'; payload: { requestId: string; parentId: string; error: string } }
  | { type: 'hover_result'; payload: { requestId: string; nodeId: string; hoverText: string } }
  | { type: 'hover_error'; payload: { requestId: string; nodeId: string; error: string } }
  | { type: 'refresh' }
  | { type: 'ping' }
  | { type: 'quit' };

export type BridgeOutgoingMessage =
  | {
      type: 'open_location';
      payload: { filePath: string; lineNumber: number; label: string };
    }
  | {
      type: 'query_relations';
      payload: {
        requestId: string;
        parentId: string;
        filePath: string;
        lineNumber: number;
        character?: number;
        mode: QueryMode;
      };
    }
  | {
      type: 'query_hover';
      payload: {
        requestId: string;
        nodeId: string;
        filePath: string;
        lineNumber: number;
        character?: number;
      };
    }
  | { type: 'request_refresh' }
  | { type: 'pong' }
  | { type: 'quit_ack' };
