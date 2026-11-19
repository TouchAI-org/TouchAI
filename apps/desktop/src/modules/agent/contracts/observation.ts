import type { TaskModelSummary } from './task';

/** Presentation metadata, not an execution event or a persisted checkpoint. */
export type ProjectionTaskEvent =
    | {
          type: 'task_started';
          sessionId: number | null;
          turnId: number | null;
          model: TaskModelSummary;
      }
    | { type: 'checkpoint_committed' | 'retry_scheduled' }
    | { type: 'task_completed'; turnId: number | null; model: TaskModelSummary }
    | { type: 'task_failed'; turnId: number | null; error: string }
    | { type: 'task_cancelled'; turnId: number | null };
