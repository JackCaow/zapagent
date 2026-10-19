package agent

type processIsolation interface {
	AfterStart() error
	Kill() error
	Cleanup() error
}

type noopIsolation struct{}

func (noopIsolation) AfterStart() error { return nil }
func (noopIsolation) Kill() error       { return nil }
func (noopIsolation) Cleanup() error    { return nil }
