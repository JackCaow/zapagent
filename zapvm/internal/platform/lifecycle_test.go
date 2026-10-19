package platform

import (
	"sync"
	"testing"
)

func TestLifecycleTransitionsAndTerminalImmutability(t *testing.T) {
	lifecycle := newLifecycleState(StateStarting)
	if before, after, ok := lifecycle.Apply(lifecycleReady); !ok || before != StateStarting || after != StateRunning {
		t.Fatalf("ready transition = %s -> %s, %v", before, after, ok)
	}
	if _, after, ok := lifecycle.Apply(lifecycleStopRequested); !ok || after != StateStopping {
		t.Fatalf("stop request state = %s, accepted = %v", after, ok)
	}
	if _, after, ok := lifecycle.Apply(lifecycleStopRejected); !ok || after != StateRunning {
		t.Fatalf("rejected stop state = %s, accepted = %v", after, ok)
	}
	if _, after, ok := lifecycle.Apply(lifecycleExited); !ok || after != StateFailed {
		t.Fatalf("unexpected exit state = %s, accepted = %v", after, ok)
	}
	for _, event := range allLifecycleEvents() {
		if _, after, ok := lifecycle.Apply(event); ok || after != StateFailed {
			t.Fatalf("terminal state changed after event %d: %s, accepted = %v", event, after, ok)
		}
	}
}

func TestLifecyclePauseResumeAndRejectedStopRestoresPaused(t *testing.T) {
	lifecycle := newLifecycleState(StateRunning)
	for _, step := range []struct {
		event lifecycleEvent
		want  State
	}{
		{lifecyclePauseRequested, StatePausing},
		{lifecyclePaused, StatePaused},
		{lifecycleStopRequested, StateStopping},
		{lifecycleStopRejected, StatePaused},
		{lifecycleResumeRequested, StateResuming},
		{lifecycleReady, StateRunning},
	} {
		if _, after, ok := lifecycle.Apply(step.event); !ok || after != step.want {
			t.Fatalf("event %d state = %s, accepted = %v; want %s", step.event, after, ok, step.want)
		}
	}
}

func TestLifecyclePauseAndResumeFailureRollBack(t *testing.T) {
	lifecycle := newLifecycleState(StateRunning)
	lifecycle.Apply(lifecyclePauseRequested)
	if _, after, ok := lifecycle.Apply(lifecyclePauseRejected); !ok || after != StateRunning {
		t.Fatalf("pause rejection = %s, %v", after, ok)
	}
	lifecycle.Apply(lifecyclePauseRequested)
	lifecycle.Apply(lifecyclePaused)
	lifecycle.Apply(lifecycleResumeRequested)
	if _, after, ok := lifecycle.Apply(lifecycleResumeRejected); !ok || after != StatePaused {
		t.Fatalf("resume rejection = %s, %v", after, ok)
	}
}

func allLifecycleEvents() []lifecycleEvent {
	return []lifecycleEvent{
		lifecycleReady, lifecyclePauseRequested, lifecyclePaused, lifecyclePauseRejected,
		lifecycleResumeRequested, lifecycleResumeRejected, lifecycleStopRequested,
		lifecycleStopRejected, lifecycleExited, lifecycleFailed,
	}
}

func TestLifecycleConcurrentTerminalEventWins(t *testing.T) {
	for iteration := 0; iteration < 100; iteration++ {
		lifecycle := newLifecycleState(StateRunning)
		start := make(chan struct{})
		var wait sync.WaitGroup
		for _, event := range []lifecycleEvent{lifecycleStopRequested, lifecycleExited, lifecycleFailed, lifecycleReady} {
			wait.Add(1)
			go func(event lifecycleEvent) {
				defer wait.Done()
				<-start
				lifecycle.Apply(event)
			}(event)
		}
		close(start)
		wait.Wait()
		state := lifecycle.State()
		if state != StateStopped && state != StateFailed {
			t.Fatalf("iteration %d ended in non-terminal state %s", iteration, state)
		}
		terminal := state
		for _, event := range allLifecycleEvents() {
			lifecycle.Apply(event)
		}
		if lifecycle.State() != terminal {
			t.Fatalf("terminal state %s was resurrected as %s", terminal, lifecycle.State())
		}
	}
}

func FuzzLifecycleEventSequences(f *testing.F) {
	f.Add([]byte{byte(lifecycleReady), byte(lifecycleStopRequested), byte(lifecycleExited)})
	f.Add([]byte{byte(lifecycleExited), byte(lifecycleReady), byte(lifecycleStopRejected)})
	f.Add([]byte{byte(lifecycleStopRequested), byte(lifecycleStopRejected), byte(lifecycleFailed)})
	f.Fuzz(func(t *testing.T, events []byte) {
		lifecycle := newLifecycleState(StateStarting)
		terminal := State("")
		for _, raw := range events {
			before := lifecycle.State()
			_, after, _ := lifecycle.Apply(lifecycleEvent(raw))
			if after != StateStarting && after != StateRunning && after != StatePausing && after != StatePaused && after != StateResuming && after != StateStopping && after != StateStopped && after != StateFailed {
				t.Fatalf("invalid lifecycle state %q", after)
			}
			if terminal != "" && after != terminal {
				t.Fatalf("terminal state changed from %s to %s", terminal, after)
			}
			if before == StateStopped || before == StateFailed {
				terminal = before
			} else if after == StateStopped || after == StateFailed {
				terminal = after
			}
		}
	})
}

func FuzzLifecycleConcurrentEvents(f *testing.F) {
	f.Add([]byte{byte(lifecycleStopRequested), byte(lifecycleExited), byte(lifecycleReady)})
	f.Add([]byte{byte(lifecycleFailed), byte(lifecycleStopRejected), byte(lifecycleExited)})
	f.Fuzz(func(t *testing.T, events []byte) {
		if len(events) > 32 {
			events = events[:32]
		}
		lifecycle := newLifecycleState(StateStarting)
		start := make(chan struct{})
		var wait sync.WaitGroup
		hasTerminalEvent := false
		for _, raw := range events {
			event := lifecycleEvent(raw)
			if event == lifecycleExited || event == lifecycleFailed {
				hasTerminalEvent = true
			}
			wait.Add(1)
			go func() {
				defer wait.Done()
				<-start
				lifecycle.Apply(event)
			}()
		}
		close(start)
		wait.Wait()
		state := lifecycle.State()
		if hasTerminalEvent && state != StateStopped && state != StateFailed {
			t.Fatalf("terminal event race ended in %s", state)
		}
		if state == StateStopped || state == StateFailed {
			for _, event := range allLifecycleEvents() {
				lifecycle.Apply(event)
			}
			if lifecycle.State() != state {
				t.Fatalf("terminal state %s changed to %s", state, lifecycle.State())
			}
		}
	})
}
