package cloudplane

import "time"

const (
	queueStuckThreshold     = 2 * time.Minute
	eventStuckThreshold     = 5 * time.Minute
	cancelStuckThreshold    = 30 * time.Second
	stateMirrorLagThreshold = 30 * time.Second
)

type OperationalAlert struct {
	Code      string `json:"code"`
	Severity  string `json:"severity"`
	Count     uint64 `json:"count"`
	Threshold string `json:"threshold"`
}

// OperationalSnapshot contains low-cardinality, administrator-only operational
// signals. It deliberately excludes tenant IDs, project IDs, task IDs, prompts,
// credentials, event data, and workspace paths.
type OperationalSnapshot struct {
	SchemaVersion                int                `json:"schema_version"`
	CollectedAt                  string             `json:"collected_at"`
	Ready                        bool               `json:"ready"`
	NodesByState                 map[string]uint64  `json:"nodes_by_state"`
	NodesByDaemonState           map[string]uint64  `json:"nodes_by_daemon_state"`
	TasksByState                 map[string]uint64  `json:"tasks_by_state"`
	WorkspaceOperationsByState   map[string]uint64  `json:"workspace_operations_by_state"`
	GitOperationsByState         map[string]uint64  `json:"git_operations_by_state"`
	OldestNodeHeartbeatAgeMillis uint64             `json:"oldest_node_heartbeat_age_ms"`
	OldestQueueAgeMillis         uint64             `json:"oldest_queue_age_ms"`
	OldestRunningAgeMillis       uint64             `json:"oldest_running_age_ms"`
	OldestCancelingAgeMillis     uint64             `json:"oldest_canceling_age_ms"`
	MaximumActiveEventLagMillis  uint64             `json:"maximum_active_event_lag_ms"`
	TerminalTaskLatencyCount     uint64             `json:"terminal_task_latency_count"`
	TerminalTaskLatencyTotalMS   uint64             `json:"terminal_task_latency_total_ms"`
	TerminalTaskLatencyMaximumMS uint64             `json:"terminal_task_latency_maximum_ms"`
	CancellationLatencyCount     uint64             `json:"cancellation_latency_count"`
	CancellationLatencyTotalMS   uint64             `json:"cancellation_latency_total_ms"`
	CancellationLatencyMaximumMS uint64             `json:"cancellation_latency_maximum_ms"`
	VMStartAttempts              uint64             `json:"vm_start_attempts"`
	VMStartFailures              uint64             `json:"vm_start_failures"`
	VMStartDurationTotalMS       uint64             `json:"vm_start_duration_ms_total"`
	VMStartDurationMaximumMS     uint64             `json:"vm_start_duration_ms_maximum"`
	StateMirrorEnabled           bool               `json:"state_mirror_enabled"`
	StateMirrorPending           bool               `json:"state_mirror_pending"`
	StateMirrorFailed            bool               `json:"state_mirror_failed"`
	StateMirrorConsecutiveErrors uint64             `json:"state_mirror_consecutive_errors"`
	StateMirrorPendingAgeMS      uint64             `json:"state_mirror_pending_age_ms"`
	StateMirrorLastSuccessAgeMS  uint64             `json:"state_mirror_last_success_age_ms"`
	StatePrimaryEnabled          bool               `json:"state_primary_enabled"`
	Alerts                       []OperationalAlert `json:"alerts"`
}

func (store *Store) Ready() error {
	store.mu.Lock()
	defer store.mu.Unlock()
	return store.readyLocked()
}

func (store *Store) OperationalSnapshot() OperationalSnapshot {
	store.mu.Lock()
	defer store.mu.Unlock()
	now := store.now().UTC()
	snapshot := OperationalSnapshot{
		SchemaVersion: 1, CollectedAt: timestamp(now), Ready: store.degraded == nil,
		NodesByState: make(map[string]uint64), NodesByDaemonState: make(map[string]uint64),
		TasksByState: make(map[string]uint64), WorkspaceOperationsByState: make(map[string]uint64), GitOperationsByState: make(map[string]uint64),
		Alerts: make([]OperationalAlert, 0),
	}
	if store.stateMirror != nil {
		health := store.stateMirror.Health()
		snapshot.StateMirrorEnabled = true
		snapshot.StateMirrorPending = health.Pending
		snapshot.StateMirrorFailed = health.Failed
		snapshot.StateMirrorConsecutiveErrors = health.ConsecutiveFailures
		if health.Pending && !health.PendingSince.IsZero() && !health.PendingSince.After(now) {
			snapshot.StateMirrorPendingAgeMS = uint64(now.Sub(health.PendingSince) / time.Millisecond)
		}
		if !health.LastSuccess.IsZero() && !health.LastSuccess.After(now) {
			snapshot.StateMirrorLastSuccessAgeMS = uint64(now.Sub(health.LastSuccess) / time.Millisecond)
		}
		if health.Failed {
			snapshot.Ready = false
			snapshot.Alerts = append(snapshot.Alerts, OperationalAlert{Code: "state_mirror_failed", Severity: "critical", Count: health.ConsecutiveFailures, Threshold: "1"})
		} else if snapshot.StateMirrorPendingAgeMS >= uint64(stateMirrorLagThreshold/time.Millisecond) {
			snapshot.Alerts = append(snapshot.Alerts, OperationalAlert{Code: "state_mirror_lag", Severity: "warning", Count: 1, Threshold: stateMirrorLagThreshold.String()})
		}
	}
	snapshot.StatePrimaryEnabled = store.statePrimary != nil
	for _, node := range store.state.Nodes {
		snapshot.NodesByState[node.State]++
		snapshot.NodesByDaemonState[node.DaemonState]++
		updateMaximumAge(&snapshot.OldestNodeHeartbeatAgeMillis, now, node.LastHeartbeat)
		snapshot.VMStartAttempts += node.StartAttempts
		snapshot.VMStartFailures += node.StartFailures
		snapshot.VMStartDurationTotalMS += node.StartDurationMillisTotal
		if node.StartDurationMillisMax > snapshot.VMStartDurationMaximumMS {
			snapshot.VMStartDurationMaximumMS = node.StartDurationMillisMax
		}
	}
	cancelRequestedAt := make(map[string]time.Time)
	for _, record := range store.state.Audit {
		if record.Action != "task_cancel" || record.TaskID == "" {
			continue
		}
		if _, exists := cancelRequestedAt[record.TaskID]; exists {
			continue
		}
		if parsed, err := parseTimestamp(record.Timestamp); err == nil {
			cancelRequestedAt[record.TaskID] = parsed
		}
	}
	for _, task := range store.state.Tasks {
		snapshot.TasksByState[task.State]++
		switch task.State {
		case TaskPending:
			updateMaximumAge(&snapshot.OldestQueueAgeMillis, now, task.CreatedAt)
		case TaskLeased, TaskRunning:
			updateMaximumAge(&snapshot.OldestRunningAgeMillis, now, task.UpdatedAt)
		case TaskCanceling:
			updateMaximumAge(&snapshot.OldestCancelingAgeMillis, now, task.UpdatedAt)
		}
		if activeTask(task.State) {
			anchor := task.CreatedAt
			if events := store.state.Events[task.ID]; len(events) != 0 {
				anchor = events[len(events)-1].Timestamp
			}
			updateMaximumAge(&snapshot.MaximumActiveEventLagMillis, now, anchor)
		}
		if terminalTask(task.State) {
			if duration, ok := elapsedMillis(task.CreatedAt, task.UpdatedAt); ok {
				addDuration(&snapshot.TerminalTaskLatencyCount, &snapshot.TerminalTaskLatencyTotalMS, &snapshot.TerminalTaskLatencyMaximumMS, duration)
			}
			if requested, ok := cancelRequestedAt[task.ID]; ok && task.State == TaskCanceled {
				if completed, err := parseTimestamp(task.UpdatedAt); err == nil && !completed.Before(requested) {
					addDuration(&snapshot.CancellationLatencyCount, &snapshot.CancellationLatencyTotalMS, &snapshot.CancellationLatencyMaximumMS, uint64(completed.Sub(requested)/time.Millisecond))
				}
			}
		}
	}
	for _, operation := range store.state.WorkspaceOperations {
		if operation.Kind == WorkspaceOperationGitPush {
			snapshot.GitOperationsByState[operation.State]++
		} else {
			snapshot.WorkspaceOperationsByState[operation.State]++
		}
	}
	if count := snapshot.NodesByState[NodeOffline]; count != 0 {
		snapshot.Alerts = append(snapshot.Alerts, OperationalAlert{Code: "node_offline", Severity: "critical", Count: count, Threshold: store.heartbeatTTL.String()})
	}
	if snapshot.OldestQueueAgeMillis >= uint64(queueStuckThreshold/time.Millisecond) {
		snapshot.Alerts = append(snapshot.Alerts, OperationalAlert{Code: "task_queue_stuck", Severity: "warning", Count: snapshot.TasksByState[TaskPending], Threshold: queueStuckThreshold.String()})
	}
	if snapshot.MaximumActiveEventLagMillis >= uint64(eventStuckThreshold/time.Millisecond) {
		count := snapshot.TasksByState[TaskLeased] + snapshot.TasksByState[TaskRunning] + snapshot.TasksByState[TaskCanceling]
		snapshot.Alerts = append(snapshot.Alerts, OperationalAlert{Code: "task_event_stuck", Severity: "critical", Count: count, Threshold: eventStuckThreshold.String()})
	}
	if snapshot.OldestCancelingAgeMillis >= uint64(cancelStuckThreshold/time.Millisecond) {
		snapshot.Alerts = append(snapshot.Alerts, OperationalAlert{Code: "task_cancel_stuck", Severity: "critical", Count: snapshot.TasksByState[TaskCanceling], Threshold: cancelStuckThreshold.String()})
	}
	return snapshot
}

func updateMaximumAge(target *uint64, now time.Time, raw string) {
	parsed, err := parseTimestamp(raw)
	if err != nil || parsed.After(now) {
		return
	}
	age := uint64(now.Sub(parsed) / time.Millisecond)
	if age > *target {
		*target = age
	}
}

func elapsedMillis(startRaw, endRaw string) (uint64, bool) {
	start, startErr := parseTimestamp(startRaw)
	end, endErr := parseTimestamp(endRaw)
	if startErr != nil || endErr != nil || end.Before(start) {
		return 0, false
	}
	return uint64(end.Sub(start) / time.Millisecond), true
}

func addDuration(count, total, maximum *uint64, duration uint64) {
	*count++
	*total += duration
	if duration > *maximum {
		*maximum = duration
	}
}
