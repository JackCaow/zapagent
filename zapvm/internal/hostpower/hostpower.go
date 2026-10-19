package hostpower

import "context"

// Handlers are invoked synchronously for platform power transitions. Suspend
// must return as quickly as the Host deadline permits; Resume may run after
// devices and transports become available again.
type Handlers struct {
	Suspend func(context.Context) error
	Resume  func(context.Context) error
	Report  func(error)
}

func (handlers Handlers) report(err error) {
	if err != nil && handlers.Report != nil {
		handlers.Report(err)
	}
}
