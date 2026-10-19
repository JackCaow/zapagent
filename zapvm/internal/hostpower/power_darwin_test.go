//go:build darwin

package hostpower

import (
	"context"
	"testing"
	"time"
)

func TestDarwinPowerMonitorRegistersAndStops(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- Monitor(ctx, Handlers{}) }()
	time.Sleep(50 * time.Millisecond)
	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("IOKit power monitor did not stop after cancellation")
	}
}
