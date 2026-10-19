//go:build windows

package main

import (
	"context"
	"time"

	"golang.org/x/sys/windows/svc"

	"zapvm/internal/cloudnode"
)

const windowsNodeServiceName = "zapvm-node"

type windowsNodeService struct {
	config  cloudnode.Config
	version string
}

func runWindowsNodeService(config cloudnode.Config, version string) error {
	return svc.Run(windowsNodeServiceName, &windowsNodeService{config: config, version: version})
}

func (service *windowsNodeService) Execute(_ []string, requests <-chan svc.ChangeRequest, changes chan<- svc.Status) (bool, uint32) {
	changes <- svc.Status{State: svc.StartPending}
	worker, err := cloudnode.NewWithVersion(service.config, nil, service.version)
	if err != nil {
		return false, 1
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- worker.Run(ctx) }()
	current := svc.Status{State: svc.Running, Accepts: svc.AcceptStop | svc.AcceptShutdown}
	changes <- current
	for {
		select {
		case err := <-done:
			if err != nil && ctx.Err() == nil {
				return false, 2
			}
			return false, 0
		case request, ok := <-requests:
			if !ok {
				cancel()
				return false, 4
			}
			switch request.Cmd {
			case svc.Interrogate:
				changes <- current
			case svc.Stop, svc.Shutdown:
				changes <- svc.Status{State: svc.StopPending}
				cancel()
				select {
				case <-done:
					return false, 0
				case <-time.After(30 * time.Second):
					return false, 3
				}
			default:
				changes <- current
			}
		}
	}
}
