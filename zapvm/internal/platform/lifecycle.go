package platform

import "sync"

type lifecycleEvent uint8

const (
	lifecycleReady lifecycleEvent = iota + 1
	lifecyclePauseRequested
	lifecyclePaused
	lifecyclePauseRejected
	lifecycleResumeRequested
	lifecycleResumeRejected
	lifecycleStopRequested
	lifecycleStopRejected
	lifecycleExited
	lifecycleFailed
)

// lifecycleState serializes VMM readiness, stop requests, and asynchronous
// process events. Stopped and failed are terminal: a late readiness or stop
// callback can never resurrect an instance after resources start to unwind.
type lifecycleState struct {
	mu         sync.RWMutex
	state      State
	beforeStop State
}

func newLifecycleState(initial State) *lifecycleState {
	return &lifecycleState{state: initial}
}

func (lifecycle *lifecycleState) State() State {
	lifecycle.mu.RLock()
	defer lifecycle.mu.RUnlock()
	return lifecycle.state
}

func (lifecycle *lifecycleState) Apply(event lifecycleEvent) (State, State, bool) {
	lifecycle.mu.Lock()
	defer lifecycle.mu.Unlock()
	before := lifecycle.state
	after, accepted := transitionLifecycle(before, lifecycle.beforeStop, event)
	if accepted {
		if event == lifecycleStopRequested && before != StateStopping {
			lifecycle.beforeStop = before
		}
		lifecycle.state = after
		if event == lifecycleStopRejected || after == StateStopped || after == StateFailed {
			lifecycle.beforeStop = ""
		}
	}
	return before, lifecycle.state, accepted
}

func transitionLifecycle(state, beforeStop State, event lifecycleEvent) (State, bool) {
	if state == StateStopped || state == StateFailed {
		return state, false
	}
	switch event {
	case lifecycleReady:
		switch state {
		case StateStarting, StateResuming:
			return StateRunning, true
		case StateRunning:
			return state, true
		default:
			return state, false
		}
	case lifecyclePauseRequested:
		if state == StateRunning {
			return StatePausing, true
		}
		return state, state == StatePausing
	case lifecyclePaused:
		if state == StatePausing {
			return StatePaused, true
		}
		return state, state == StatePaused
	case lifecyclePauseRejected:
		if state != StatePausing {
			return state, false
		}
		return StateRunning, true
	case lifecycleResumeRequested:
		if state == StatePaused {
			return StateResuming, true
		}
		return state, state == StateResuming
	case lifecycleResumeRejected:
		if state != StateResuming {
			return state, false
		}
		return StatePaused, true
	case lifecycleStopRequested:
		if state == StateStarting || state == StateRunning || state == StatePaused {
			return StateStopping, true
		}
		return state, state == StateStopping
	case lifecycleStopRejected:
		if state != StateStopping {
			return state, false
		}
		switch beforeStop {
		case StateStarting, StateRunning, StatePaused:
			return beforeStop, true
		default:
			return StateFailed, true
		}
	case lifecycleExited:
		if state == StateStopping {
			return StateStopped, true
		}
		return StateFailed, true
	case lifecycleFailed:
		return StateFailed, true
	default:
		return state, false
	}
}
