package controlpostgres

import (
	"testing"

	"zapvm/internal/cloudplane"
)

func TestApplyAgentComputerAvailability(t *testing.T) {
	tests := []struct {
		name      string
		computer  cloudplane.AgentComputer
		reachable bool
		wantState string
		wantCode  string
	}{
		{
			name: "recovered node clears stale offline status",
			computer: cloudplane.AgentComputer{State: cloudplane.NodeOffline,
				ObservedState: cloudplane.ComputerObservedUnavailable, FailureCode: cloudplane.QueueReasonNodeOffline},
			reachable: true, wantState: cloudplane.NodeOnline,
		},
		{
			name: "idle on-demand computer remains logically available",
			computer: cloudplane.AgentComputer{State: cloudplane.NodeOffline,
				ObservedState: cloudplane.ComputerObservedUnavailable, FailureCode: "computer_idle_stopped"},
			reachable: true, wantState: cloudplane.NodeOnline,
		},
		{
			name: "offline node remains offline",
			computer: cloudplane.AgentComputer{State: cloudplane.NodeOffline,
				ObservedState: cloudplane.ComputerObservedUnavailable, FailureCode: cloudplane.QueueReasonNodeOffline},
			reachable: false, wantState: cloudplane.NodeOffline, wantCode: cloudplane.QueueReasonNodeOffline,
		},
		{
			name: "real runtime failure is preserved",
			computer: cloudplane.AgentComputer{State: cloudplane.NodeDraining,
				ObservedState: cloudplane.ComputerObservedDegraded, FailureCode: "daemon_start_failed"},
			reachable: true, wantState: cloudplane.NodeDraining, wantCode: "daemon_start_failed",
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			applyAgentComputerAvailability(&test.computer, test.reachable)
			if test.computer.State != test.wantState || test.computer.FailureCode != test.wantCode {
				t.Fatalf("Computer availability=%#v want state=%q failure=%q", test.computer, test.wantState, test.wantCode)
			}
		})
	}
}
