package agent

type processIsolation interface {
	AfterStart() error
	Kill() error
	// Seal kills the isolated workload and proves that no process remains.
	// A nil receipt means the backend does not provide this guarantee.
	Seal() (*ProcessSeal, error)
	Cleanup() error
}

type noopIsolation struct{}

func (noopIsolation) AfterStart() error           { return nil }
func (noopIsolation) Kill() error                 { return nil }
func (noopIsolation) Seal() (*ProcessSeal, error) { return nil, nil }
func (noopIsolation) Cleanup() error              { return nil }
