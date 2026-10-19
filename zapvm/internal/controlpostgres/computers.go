package controlpostgres

import (
	"context"
	"errors"
	"math"
	"time"

	"github.com/jackc/pgx/v5"

	"zapvm/internal/cloudplane"
)

type computerPlacement struct {
	nodeID         string
	nodeGeneration string
	epoch          uint64
}

// reconcileComputerRuntimes materializes the current Computer view from the
// selected placement authority, Node health, and active Task leases. Static
// mode preserves the compatibility mapping; dynamic mode uses the fenced
// placement ledger without pretending that placement itself starts a VM.
func (queue *Queue) reconcileComputerRuntimes(ctx context.Context, transaction pgx.Tx, now time.Time) error {
	if queue.placementMode == "dynamic" {
		return queue.reconcileDynamicComputerRuntimes(ctx, transaction, now)
	}
	_, err := transaction.Exec(ctx, `
INSERT INTO zapvm.computer_runtime
    (tenant_id,project_id,computer_id,desired_state,observed_state,assigned_node_id,last_activity_at,failure_code,updated_at)
SELECT computer.tenant_id,computer.project_id,computer.computer_id,'running',
       CASE
         WHEN EXISTS (
           SELECT 1 FROM zapvm.tasks AS task
           JOIN zapvm.nodes AS active_node ON active_node.id=task.node_id
           WHERE task.tenant_id=computer.tenant_id AND task.project_id=computer.project_id
             AND task.computer_id=computer.computer_id AND task.state IN ('leased','running','canceling')
             AND active_node.state='online' AND active_node.last_heartbeat>$2
             AND active_node.daemon_state IN ('unknown','healthy')
         ) THEN 'busy'
         WHEN EXISTS (
           SELECT 1 FROM zapvm.computer_nodes AS placement
           JOIN zapvm.nodes AS ready_node ON ready_node.id=placement.node_id
           WHERE placement.tenant_id=computer.tenant_id AND placement.project_id=computer.project_id
             AND placement.computer_id=computer.computer_id AND ready_node.state='online'
             AND ready_node.last_heartbeat>$2 AND ready_node.daemon_state IN ('unknown','healthy')
         ) THEN 'ready'
         WHEN EXISTS (
           SELECT 1 FROM zapvm.computer_nodes AS placement
           JOIN zapvm.nodes AS degraded_node ON degraded_node.id=placement.node_id
           WHERE placement.tenant_id=computer.tenant_id AND placement.project_id=computer.project_id
             AND placement.computer_id=computer.computer_id AND degraded_node.last_heartbeat>$2
             AND (degraded_node.state='draining' OR degraded_node.daemon_state IN ('paused','degraded','unreachable'))
         ) THEN 'degraded'
         ELSE 'unavailable'
       END,
       COALESCE(
         (SELECT task.node_id FROM zapvm.tasks AS task
          JOIN zapvm.nodes AS active_node ON active_node.id=task.node_id
          WHERE task.tenant_id=computer.tenant_id AND task.project_id=computer.project_id
            AND task.computer_id=computer.computer_id AND task.state IN ('leased','running','canceling')
            AND active_node.state='online' AND active_node.last_heartbeat>$2
          ORDER BY task.updated_at DESC,task.id LIMIT 1),
         (SELECT placement.node_id FROM zapvm.computer_nodes AS placement
          JOIN zapvm.nodes AS candidate ON candidate.id=placement.node_id
          WHERE placement.tenant_id=computer.tenant_id AND placement.project_id=computer.project_id
            AND placement.computer_id=computer.computer_id AND candidate.last_heartbeat>$2
          ORDER BY (candidate.state='online' AND candidate.daemon_state IN ('unknown','healthy')) DESC,
                   candidate.last_heartbeat DESC,candidate.id LIMIT 1)
       ),
       COALESCE((SELECT max(task.updated_at) FROM zapvm.tasks AS task
                 WHERE task.tenant_id=computer.tenant_id AND task.project_id=computer.project_id
                   AND task.computer_id=computer.computer_id),computer.created_at,$1),
       CASE
         WHEN EXISTS (
           SELECT 1 FROM zapvm.computer_nodes AS placement
           JOIN zapvm.nodes AS ready_node ON ready_node.id=placement.node_id
           WHERE placement.tenant_id=computer.tenant_id AND placement.project_id=computer.project_id
             AND placement.computer_id=computer.computer_id AND ready_node.state='online'
             AND ready_node.last_heartbeat>$2 AND ready_node.daemon_state IN ('unknown','healthy')
         ) THEN NULL
         WHEN EXISTS (
           SELECT 1 FROM zapvm.computer_nodes AS placement
           JOIN zapvm.nodes AS degraded_node ON degraded_node.id=placement.node_id
           WHERE placement.tenant_id=computer.tenant_id AND placement.project_id=computer.project_id
             AND placement.computer_id=computer.computer_id AND degraded_node.last_heartbeat>$2
             AND degraded_node.failure_code IS NOT NULL
         ) THEN (SELECT degraded_node.failure_code FROM zapvm.computer_nodes AS placement
                  JOIN zapvm.nodes AS degraded_node ON degraded_node.id=placement.node_id
                  WHERE placement.tenant_id=computer.tenant_id AND placement.project_id=computer.project_id
                    AND placement.computer_id=computer.computer_id AND degraded_node.failure_code IS NOT NULL
                  ORDER BY degraded_node.last_heartbeat DESC,degraded_node.id LIMIT 1)
		 WHEN EXISTS (
		   SELECT 1 FROM zapvm.computer_nodes AS placement
		   JOIN zapvm.nodes AS degraded_node ON degraded_node.id=placement.node_id
		   WHERE placement.tenant_id=computer.tenant_id AND placement.project_id=computer.project_id
		     AND placement.computer_id=computer.computer_id AND degraded_node.last_heartbeat>$2
		     AND (degraded_node.state='draining' OR degraded_node.daemon_state IN ('paused','degraded','unreachable'))
		 ) THEN 'node_degraded'
         ELSE 'node_offline'
       END,
       $1
FROM zapvm.computers AS computer
ON CONFLICT (tenant_id,project_id,computer_id) DO UPDATE SET
    observed_state=EXCLUDED.observed_state,
    assigned_node_id=EXCLUDED.assigned_node_id,
    last_activity_at=GREATEST(zapvm.computer_runtime.last_activity_at,EXCLUDED.last_activity_at),
    failure_code=EXCLUDED.failure_code,
    updated_at=EXCLUDED.updated_at`, now, now.Add(-queue.heartbeatTTL))
	if err != nil {
		return databaseFailure("reconcile PostgreSQL Computer runtimes", err)
	}
	return nil
}

func (queue *Queue) ensureDynamicPlacement(ctx context.Context, transaction pgx.Tx, scope cloudplane.Scope, computerID string, now time.Time) (computerPlacement, bool, error) {
	if queue.placementMode != cloudplane.PlacementModeDynamic {
		return computerPlacement{}, false, nil
	}
	if _, err := transaction.Exec(ctx, `
INSERT INTO zapvm.computer_runtime
    (tenant_id,project_id,computer_id,desired_state,observed_state,last_activity_at,updated_at)
SELECT tenant_id,project_id,computer_id,'running','unavailable',created_at,$4
FROM zapvm.computers WHERE tenant_id=$1 AND project_id=$2 AND computer_id=$3
ON CONFLICT (tenant_id,project_id,computer_id) DO NOTHING`, scope.TenantID, scope.ProjectID, computerID, now); err != nil {
		return computerPlacement{}, false, databaseFailure("initialize PostgreSQL Computer runtime", err)
	}
	var currentEpoch int64
	if err := transaction.QueryRow(ctx, `
SELECT placement_epoch FROM zapvm.computer_runtime
WHERE tenant_id=$1 AND project_id=$2 AND computer_id=$3 FOR UPDATE`, scope.TenantID, scope.ProjectID, computerID).Scan(&currentEpoch); errors.Is(err, pgx.ErrNoRows) {
		return computerPlacement{}, false, cloudplane.ErrUnavailable
	} else if err != nil {
		return computerPlacement{}, false, databaseFailure("lock PostgreSQL Computer placement epoch", err)
	}
	if currentEpoch < 0 {
		return computerPlacement{}, false, errors.New("PostgreSQL Computer placement epoch is invalid")
	}
	if currentEpoch == math.MaxInt64 {
		return computerPlacement{}, false, cloudplane.ErrQuotaReached
	}

	var active computerPlacement
	var activeEpoch int64
	var nodeState, currentGeneration, daemonState string
	var lastHeartbeat time.Time
	var hasActiveTasks bool
	err := transaction.QueryRow(ctx, `
SELECT placement.node_id,placement.node_generation,placement.epoch,
       node.state,node.generation,node.daemon_state,node.last_heartbeat,
       EXISTS (
         SELECT 1 FROM zapvm.tasks AS task
         WHERE task.tenant_id=placement.tenant_id AND task.project_id=placement.project_id
           AND task.computer_id=placement.computer_id AND task.placement_epoch=placement.epoch
           AND task.state IN ('leased','running','canceling')
       )
FROM zapvm.computer_placements AS placement
JOIN zapvm.nodes AS node ON node.id=placement.node_id
WHERE placement.tenant_id=$1 AND placement.project_id=$2 AND placement.computer_id=$3
  AND placement.state='ready'
FOR UPDATE OF placement,node`, scope.TenantID, scope.ProjectID, computerID).Scan(
		&active.nodeID, &active.nodeGeneration, &activeEpoch, &nodeState, &currentGeneration, &daemonState, &lastHeartbeat, &hasActiveTasks,
	)
	if err == nil {
		if activeEpoch < 1 {
			return computerPlacement{}, false, errors.New("PostgreSQL Computer placement epoch is invalid")
		}
		active.epoch = uint64(activeEpoch)
		var releasePending bool
		if err := transaction.QueryRow(ctx, `SELECT EXISTS (
SELECT 1 FROM zapvm.computer_operations
WHERE tenant_id=$1 AND project_id=$2 AND computer_id=$3 AND placement_epoch=$4
  AND kind='stop' AND state IN ('pending','leased'))`, scope.TenantID, scope.ProjectID, computerID, activeEpoch).Scan(&releasePending); err != nil {
			return computerPlacement{}, false, databaseFailure("inspect PostgreSQL Computer release transition", err)
		}
		if releasePending {
			return computerPlacement{}, false, cloudplane.ErrConflict
		}
		valid := nodeState == cloudplane.NodeOnline && currentGeneration == active.nodeGeneration &&
			now.Sub(lastHeartbeat) <= queue.heartbeatTTL && (daemonState == cloudplane.DaemonUnknown || daemonState == cloudplane.DaemonHealthy)
		if valid || hasActiveTasks {
			return active, true, nil
		}
		if _, err := transaction.Exec(ctx, `
UPDATE zapvm.computer_placements SET state='released',reason='node_unavailable',released_at=$1
WHERE tenant_id=$2 AND project_id=$3 AND computer_id=$4 AND epoch=$5 AND state='ready'`, now, scope.TenantID, scope.ProjectID, computerID, activeEpoch); err != nil {
			return computerPlacement{}, false, databaseFailure("release stale PostgreSQL Computer placement", err)
		}
		if err := queue.failComputerOperationsForPlacement(ctx, transaction, scope, computerID, activeEpoch, now); err != nil {
			return computerPlacement{}, false, err
		}
		if err := queue.reconcileNodeResourceCounters(ctx, transaction, active.nodeID, now); err != nil {
			return computerPlacement{}, false, err
		}
	} else if !errors.Is(err, pgx.ErrNoRows) {
		return computerPlacement{}, false, databaseFailure("inspect PostgreSQL Computer placement", err)
	}

	var requestedVCPU int64
	var requestedMemory int64
	var requestedBrowser bool
	if err := transaction.QueryRow(ctx, `
SELECT COALESCE((SELECT vcpu FROM zapvm.computer_profiles WHERE tenant_id=$1 AND project_id=$2 AND computer_id=$3),1),
       COALESCE((SELECT memory_bytes FROM zapvm.computer_profiles WHERE tenant_id=$1 AND project_id=$2 AND computer_id=$3),536870912),
       COALESCE((SELECT browser_enabled FROM zapvm.computer_profiles WHERE tenant_id=$1 AND project_id=$2 AND computer_id=$3),false)`, scope.TenantID, scope.ProjectID, computerID).Scan(&requestedVCPU, &requestedMemory, &requestedBrowser); err != nil {
		return computerPlacement{}, false, databaseFailure("resolve PostgreSQL Computer placement resources", err)
	}
	var candidate computerPlacement
	err = transaction.QueryRow(ctx, `
SELECT node.id,node.generation
FROM zapvm.nodes AS node
JOIN zapvm.node_scopes AS scope
  ON scope.node_id=node.id AND scope.tenant_id=$1 AND scope.project_id=$2
JOIN zapvm.node_resources AS resources ON resources.node_id=node.id
WHERE node.state='online' AND node.last_heartbeat>$4
  AND node.daemon_state IN ('unknown','healthy')
  AND (
    SELECT count(*) FROM zapvm.computer_placements AS reserved
    WHERE reserved.node_id=node.id AND reserved.state='ready'
  ) < resources.vm_slots
  AND $5 <= resources.allocatable_vcpu-COALESCE((
    SELECT sum(COALESCE(profile.vcpu,1)) FROM zapvm.computer_placements AS active
    LEFT JOIN zapvm.computer_profiles AS profile
      ON profile.tenant_id=active.tenant_id AND profile.project_id=active.project_id AND profile.computer_id=active.computer_id
    WHERE active.node_id=node.id AND active.state='ready'
  ),0)
  AND (resources.allocatable_memory_bytes=0 OR $6 <= resources.allocatable_memory_bytes-COALESCE((
    SELECT sum(COALESCE(profile.memory_bytes,536870912)) FROM zapvm.computer_placements AS active
    LEFT JOIN zapvm.computer_profiles AS profile
      ON profile.tenant_id=active.tenant_id AND profile.project_id=active.project_id AND profile.computer_id=active.computer_id
    WHERE active.node_id=node.id AND active.state='ready'
  ),0))
  AND (NOT $7 OR resources.browser_slots > COALESCE((
    SELECT count(*) FILTER (WHERE profile.browser_enabled) FROM zapvm.computer_placements AS active
    LEFT JOIN zapvm.computer_profiles AS profile
      ON profile.tenant_id=active.tenant_id AND profile.project_id=active.project_id AND profile.computer_id=active.computer_id
    WHERE active.node_id=node.id AND active.state='ready'
  ),0))
  AND (
    EXISTS (
      SELECT 1 FROM zapvm.computer_nodes AS allowed
      WHERE allowed.node_id=node.id AND allowed.tenant_id=$1 AND allowed.project_id=$2 AND allowed.computer_id=$3
    )
    OR NOT EXISTS (
      SELECT 1 FROM zapvm.computer_nodes AS configured
      WHERE configured.tenant_id=$1 AND configured.project_id=$2
    )
  )
ORDER BY (resources.vm_slots-(
           SELECT count(*) FROM zapvm.computer_placements AS reserved
           WHERE reserved.node_id=node.id AND reserved.state='ready'
         )) DESC,
         (node.capacity-node.in_flight) DESC,node.start_failures ASC,node.last_heartbeat DESC,node.id
FOR UPDATE OF node,resources SKIP LOCKED
LIMIT 1`, scope.TenantID, scope.ProjectID, computerID, now.Add(-queue.heartbeatTTL), requestedVCPU, requestedMemory, requestedBrowser).Scan(&candidate.nodeID, &candidate.nodeGeneration)
	if errors.Is(err, pgx.ErrNoRows) {
		if _, updateErr := transaction.Exec(ctx, `
UPDATE zapvm.computer_runtime SET observed_state='unavailable',assigned_node_id=NULL,
    failure_code='node_offline',updated_at=$1
WHERE tenant_id=$2 AND project_id=$3 AND computer_id=$4`, now, scope.TenantID, scope.ProjectID, computerID); updateErr != nil {
			return computerPlacement{}, false, databaseFailure("mark PostgreSQL Computer unplaced", updateErr)
		}
		return computerPlacement{}, false, nil
	}
	if err != nil {
		return computerPlacement{}, false, databaseFailure("select PostgreSQL Computer placement Node", err)
	}
	candidate.epoch = uint64(currentEpoch + 1)
	if _, err := transaction.Exec(ctx, `
INSERT INTO zapvm.computer_placements
    (tenant_id,project_id,computer_id,epoch,node_id,node_generation,state,reason,created_at,ready_at)
VALUES ($1,$2,$3,$4,$5,$6,'ready','scheduler',$7,$7)`, scope.TenantID, scope.ProjectID, computerID, int64(candidate.epoch), candidate.nodeID, candidate.nodeGeneration, now); err != nil {
		return computerPlacement{}, false, databaseFailure("create PostgreSQL Computer placement", err)
	}
	if _, err := transaction.Exec(ctx, `
UPDATE zapvm.computer_runtime SET observed_state='ready',assigned_node_id=$1,placement_epoch=$2,
    failure_code=NULL,updated_at=$3
WHERE tenant_id=$4 AND project_id=$5 AND computer_id=$6`, candidate.nodeID, int64(candidate.epoch), now, scope.TenantID, scope.ProjectID, computerID); err != nil {
		return computerPlacement{}, false, databaseFailure("activate PostgreSQL Computer placement", err)
	}
	if _, err := appendAudit(ctx, transaction, now, auditInput{action: "computer_placement", scope: scope, nodeID: candidate.nodeID, outcome: "ready"}); err != nil {
		return computerPlacement{}, false, err
	}
	return candidate, true, nil
}

func (queue *Queue) reconcileDynamicComputerRuntimes(ctx context.Context, transaction pgx.Tx, now time.Time) error {
	if _, err := transaction.Exec(ctx, `
INSERT INTO zapvm.computer_runtime
    (tenant_id,project_id,computer_id,desired_state,observed_state,last_activity_at,updated_at)
SELECT tenant_id,project_id,computer_id,'running','unavailable',created_at,$1 FROM zapvm.computers
ON CONFLICT (tenant_id,project_id,computer_id) DO NOTHING`, now); err != nil {
		return databaseFailure("initialize dynamic PostgreSQL Computer runtimes", err)
	}
	_, err := transaction.Exec(ctx, `
UPDATE zapvm.computer_runtime AS runtime SET
    observed_state=CASE
      WHEN stop_operation.state IN ('pending','leased','succeeded') THEN 'unavailable'
      WHEN stop_operation.state='failed' THEN 'degraded'
      WHEN placement.epoch IS NOT NULL AND start_operation.state='succeeded'
        AND node.state='online' AND node.generation=placement.node_generation
        AND node.last_heartbeat>$2 AND node.daemon_state IN ('unknown','healthy')
        AND EXISTS (
          SELECT 1 FROM zapvm.tasks AS task
          WHERE task.tenant_id=runtime.tenant_id AND task.project_id=runtime.project_id
            AND task.computer_id=runtime.computer_id AND task.placement_epoch=placement.epoch
            AND task.state IN ('leased','running','canceling')
        ) THEN 'busy'
      WHEN placement.epoch IS NOT NULL AND start_operation.state='succeeded'
        AND node.state='online' AND node.generation=placement.node_generation
        AND node.last_heartbeat>$2 AND node.daemon_state IN ('unknown','healthy') THEN 'ready'
      WHEN start_operation.state='failed' THEN 'degraded'
      WHEN placement.epoch IS NOT NULL AND node.last_heartbeat>$2 THEN 'degraded'
      ELSE 'unavailable'
    END,
    assigned_node_id=placement.node_id,
    placement_epoch=COALESCE(placement.epoch,runtime.placement_epoch),
    last_activity_at=GREATEST(runtime.last_activity_at,(
      SELECT max(task.updated_at) FROM zapvm.tasks AS task
      WHERE task.tenant_id=runtime.tenant_id AND task.project_id=runtime.project_id
        AND task.computer_id=runtime.computer_id
    )),
    failure_code=CASE
      WHEN stop_operation.state IN ('pending','leased') THEN 'computer_stopping'
      WHEN stop_operation.state='failed' THEN stop_operation.failure_code
      WHEN stop_operation.state='succeeded' THEN 'computer_idle_stopped'
      WHEN placement.epoch IS NULL THEN 'node_offline'
      WHEN start_operation.state='failed' THEN start_operation.failure_code
      WHEN start_operation.state='succeeded' AND node.state='online' AND node.generation=placement.node_generation
        AND node.last_heartbeat>$2 AND node.daemon_state IN ('unknown','healthy') THEN NULL
      WHEN node.last_heartbeat>$2 THEN COALESCE(node.failure_code,'node_degraded')
      ELSE 'node_offline'
    END,
    updated_at=$1
FROM zapvm.computer_runtime AS runtime_snapshot
JOIN zapvm.computers AS computer
  ON computer.tenant_id=runtime_snapshot.tenant_id AND computer.project_id=runtime_snapshot.project_id
  AND computer.computer_id=runtime_snapshot.computer_id
LEFT JOIN zapvm.computer_placements AS placement
  ON placement.tenant_id=computer.tenant_id AND placement.project_id=computer.project_id
  AND placement.computer_id=computer.computer_id AND placement.state='ready'
LEFT JOIN zapvm.nodes AS node ON node.id=placement.node_id
LEFT JOIN zapvm.computer_operations AS start_operation
  ON start_operation.tenant_id=computer.tenant_id AND start_operation.project_id=computer.project_id
  AND start_operation.computer_id=computer.computer_id AND start_operation.placement_epoch=placement.epoch
  AND start_operation.kind='start'
LEFT JOIN LATERAL (
  SELECT operation.state,operation.failure_code
  FROM zapvm.computer_operations AS operation
  WHERE operation.tenant_id=runtime_snapshot.tenant_id AND operation.project_id=runtime_snapshot.project_id
    AND operation.computer_id=runtime_snapshot.computer_id AND operation.placement_epoch=runtime_snapshot.placement_epoch
    AND operation.kind='stop'
  ORDER BY operation.created_at DESC,operation.id DESC LIMIT 1
) AS stop_operation ON true
WHERE runtime.tenant_id=runtime_snapshot.tenant_id AND runtime.project_id=runtime_snapshot.project_id
  AND runtime.computer_id=runtime_snapshot.computer_id`, now, now.Add(-queue.heartbeatTTL))
	if err != nil {
		return databaseFailure("reconcile dynamic PostgreSQL Computer runtimes", err)
	}
	return nil
}

func (queue *Queue) releaseDynamicPlacementsForNodeGeneration(ctx context.Context, transaction pgx.Tx, nodeID, generation string, now time.Time) error {
	return queue.releaseIdleDynamicPlacements(ctx, transaction, nodeID, generation, "node_generation_fenced", now)
}

// reconcileReportedComputerRuntimes closes the gap between the daemon-owned
// warm VM pool and the durable placement ledger. The daemon is the authority
// on whether an idle worker has actually stopped; the control plane releases
// only a successfully-started placement owned by this exact Node generation,
// and never one that still has an active Task lease.
func (queue *Queue) reconcileReportedComputerRuntimes(ctx context.Context, transaction pgx.Tx, nodeID, generation string, report cloudplane.NodeReport, now time.Time) error {
	if queue.placementMode != cloudplane.PlacementModeDynamic || report.DaemonState != cloudplane.DaemonHealthy {
		return nil
	}
	stopped := make([]string, 0, len(report.ComputerRuntimes))
	for _, runtime := range report.ComputerRuntimes {
		if runtime.State == "stopped" {
			stopped = append(stopped, runtime.ID)
		}
	}
	if len(stopped) == 0 {
		return nil
	}
	// Lock the exact placement rows before checking active Tasks. Task claim also
	// locks its placement row, so the statement below gets a fresh READ COMMITTED
	// snapshot after either side wins the lock. This prevents a stale stopped
	// heartbeat from releasing a placement concurrently claimed by a Task.
	rows, err := transaction.Query(ctx, `
SELECT placement.tenant_id,placement.project_id,placement.computer_id,placement.epoch
FROM zapvm.computer_placements AS placement
WHERE placement.node_id=$1 AND placement.node_generation=$2 AND placement.state='ready'
  AND placement.computer_id=ANY($3)
  AND EXISTS (
    SELECT 1 FROM zapvm.computer_operations AS operation
    WHERE operation.tenant_id=placement.tenant_id AND operation.project_id=placement.project_id
      AND operation.computer_id=placement.computer_id AND operation.placement_epoch=placement.epoch
      AND operation.kind='start' AND operation.state='succeeded'
  )
FOR UPDATE OF placement`, nodeID, generation, stopped)
	if err != nil {
		return databaseFailure("lock idle-stopped PostgreSQL Computer placements", err)
	}
	type releasedPlacement struct {
		scope      cloudplane.Scope
		computerID string
		epoch      int64
	}
	candidates := make([]releasedPlacement, 0)
	for rows.Next() {
		var placement releasedPlacement
		if err := rows.Scan(&placement.scope.TenantID, &placement.scope.ProjectID, &placement.computerID, &placement.epoch); err != nil {
			rows.Close()
			return errors.New("decode idle-stopped PostgreSQL Computer placement")
		}
		candidates = append(candidates, placement)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return errors.New("read idle-stopped PostgreSQL Computer placements")
	}
	released := make([]releasedPlacement, 0, len(candidates))
	for _, placement := range candidates {
		command, err := transaction.Exec(ctx, `
UPDATE zapvm.computer_placements AS current
SET state='released',reason='idle_stopped',released_at=$1
WHERE current.tenant_id=$2 AND current.project_id=$3 AND current.computer_id=$4 AND current.epoch=$5
  AND current.state='ready'
  AND NOT EXISTS (
    SELECT 1 FROM zapvm.tasks AS task
    WHERE task.tenant_id=current.tenant_id AND task.project_id=current.project_id
      AND task.computer_id=current.computer_id AND task.placement_epoch=current.epoch
      AND task.state IN ('leased','running','canceling')
  )`, now, placement.scope.TenantID, placement.scope.ProjectID, placement.computerID, placement.epoch)
		if err != nil {
			return databaseFailure("release idle-stopped PostgreSQL Computer placement", err)
		}
		if command.RowsAffected() == 0 {
			continue
		}
		released = append(released, placement)
		if _, err := transaction.Exec(ctx, `
UPDATE zapvm.computer_runtime SET observed_state='unavailable',assigned_node_id=NULL,
    failure_code='computer_idle_stopped',updated_at=$1
WHERE tenant_id=$2 AND project_id=$3 AND computer_id=$4 AND placement_epoch=$5`, now,
			placement.scope.TenantID, placement.scope.ProjectID, placement.computerID, placement.epoch); err != nil {
			return databaseFailure("clear idle-stopped PostgreSQL Computer runtime", err)
		}
		if _, err := appendAudit(ctx, transaction, now, auditInput{action: "computer_placement_release", scope: placement.scope, nodeID: nodeID, outcome: "idle_stopped"}); err != nil {
			return err
		}
	}
	if len(released) != 0 {
		return queue.reconcileNodeResourceCounters(ctx, transaction, nodeID, now)
	}
	return nil
}

func (queue *Queue) releaseIdleDynamicPlacements(ctx context.Context, transaction pgx.Tx, nodeID, generation, reason string, now time.Time) error {
	if queue.placementMode != cloudplane.PlacementModeDynamic {
		return nil
	}
	rows, err := transaction.Query(ctx, `
UPDATE zapvm.computer_placements AS placement
SET state='released',reason=$4,released_at=$1
WHERE placement.node_id=$2 AND placement.node_generation=$3 AND placement.state='ready'
  AND NOT EXISTS (
    SELECT 1 FROM zapvm.tasks AS task
    WHERE task.tenant_id=placement.tenant_id AND task.project_id=placement.project_id
      AND task.computer_id=placement.computer_id AND task.placement_epoch=placement.epoch
      AND task.state IN ('leased','running','canceling')
  )
RETURNING tenant_id,project_id,computer_id,epoch`, now, nodeID, generation, reason)
	if err != nil {
		return databaseFailure("release fenced PostgreSQL Computer placements", err)
	}
	type releasedPlacement struct {
		scope      cloudplane.Scope
		computerID string
		epoch      int64
	}
	released := make([]releasedPlacement, 0)
	for rows.Next() {
		var placement releasedPlacement
		if err := rows.Scan(&placement.scope.TenantID, &placement.scope.ProjectID, &placement.computerID, &placement.epoch); err != nil {
			rows.Close()
			return errors.New("decode released PostgreSQL Computer placement")
		}
		released = append(released, placement)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return errors.New("read released PostgreSQL Computer placements")
	}
	for _, placement := range released {
		if err := queue.failComputerOperationsForPlacement(ctx, transaction, placement.scope, placement.computerID, placement.epoch, now); err != nil {
			return err
		}
		failureCode := "node_offline"
		if reason == "node_draining" {
			failureCode = "node_degraded"
		}
		if _, err := transaction.Exec(ctx, `
UPDATE zapvm.computer_runtime SET observed_state='unavailable',assigned_node_id=NULL,
    failure_code=$6,updated_at=$1
WHERE tenant_id=$2 AND project_id=$3 AND computer_id=$4 AND placement_epoch=$5`, now, placement.scope.TenantID, placement.scope.ProjectID, placement.computerID, placement.epoch, failureCode); err != nil {
			return databaseFailure("clear fenced PostgreSQL Computer runtime", err)
		}
		if _, err := appendAudit(ctx, transaction, now, auditInput{action: "computer_placement_release", scope: placement.scope, nodeID: nodeID, outcome: reason}); err != nil {
			return err
		}
	}
	return queue.reconcileNodeResourceCounters(ctx, transaction, nodeID, now)
}
