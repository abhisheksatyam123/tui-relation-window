/**
 * EdgeKind → BackendConnectionKind adapter.
 *
 * EdgeKind is a type alias for SystemConnectionKind (src/graph/core.ts).
 * BackendConnectionKind has the same value set (src/lib/backend-types.ts).
 * This adapter provides an explicit mapping with a safe fallback for unknown values.
 */
import type { SystemConnectionKind } from './types';
import type { BackendConnectionKind } from './backend-types';

/**
 * Map an EdgeKind (= SystemConnectionKind) to a BackendConnectionKind.
 *
 * Since both types share the same value set, this is an identity mapping
 * with a safe fallback to 'custom' for unknown/future values.
 * Unknown values never throw — they return 'custom'.
 */
export function edgeKindToConnectionKind(kind: SystemConnectionKind): BackendConnectionKind {
  switch (kind) {
    case 'api_call':              return 'api_call';
    case 'interface_registration': return 'interface_registration';
    case 'sw_thread_comm':        return 'sw_thread_comm';
    case 'hw_interrupt':          return 'hw_interrupt';
    case 'hw_ring':               return 'hw_ring';
    case 'ring_signal':           return 'ring_signal';
    case 'event':                 return 'event';
    case 'timer_callback':        return 'timer_callback';
    case 'deferred_work':         return 'deferred_work';
    case 'debugfs_op':            return 'debugfs_op';
    case 'ioctl_dispatch':        return 'ioctl_dispatch';
    case 'ring_completion':       return 'ring_completion';
    case 'custom':                return 'custom';
    default:                      return 'custom';
  }
}
