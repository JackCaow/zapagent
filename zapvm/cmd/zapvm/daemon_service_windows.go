//go:build windows

package main

import (
	"errors"
	"flag"
	"time"

	"golang.org/x/sys/windows/svc"

	"zapvm/internal/daemonconfig"
	"zapvm/internal/daemonrpc"
)

const windowsDaemonServiceName = "zapvm-daemon"

type windowsDaemonService struct {
	configPath string
	endpoint   string
}

func runDaemonService(args []string) error {
	flags := flag.NewFlagSet("daemon service-run", flag.ContinueOnError)
	configPath := flags.String("config", "", "owner-only daemon JSON configuration")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if flags.NArg() != 0 || *configPath == "" {
		return errors.New("daemon service-run requires --config and accepts no positional arguments")
	}
	config, err := daemonconfig.Load(*configPath)
	if err != nil {
		return err
	}
	return svc.Run(windowsDaemonServiceName, &windowsDaemonService{configPath: *configPath, endpoint: config.Endpoint})
}

func (service *windowsDaemonService) Execute(_ []string, requests <-chan svc.ChangeRequest, changes chan<- svc.Status) (bool, uint32) {
	changes <- svc.Status{State: svc.StartPending}
	done := make(chan error, 1)
	go func() {
		done <- runDaemonConfigured([]string{"--config", service.configPath})
	}()

	readyDeadline := time.NewTimer(30 * time.Second)
	probe := time.NewTicker(250 * time.Millisecond)
	defer readyDeadline.Stop()
	defer probe.Stop()
	for {
		select {
		case err := <-done:
			if err != nil {
				return false, 1
			}
			return false, 0
		case <-readyDeadline.C:
			return false, 2
		case <-probe.C:
			response, err := daemonSimpleRequest(service.endpoint, daemonrpc.TypeStatus)
			if err == nil && response.Type == daemonrpc.TypeStatus {
				changes <- svc.Status{State: svc.Running, Accepts: svc.AcceptStop | svc.AcceptShutdown}
				return service.serve(requests, changes, done)
			}
		}
	}
}

func (service *windowsDaemonService) serve(requests <-chan svc.ChangeRequest, changes chan<- svc.Status, done <-chan error) (bool, uint32) {
	current := svc.Status{State: svc.Running, Accepts: svc.AcceptStop | svc.AcceptShutdown}
	for {
		select {
		case err := <-done:
			if err != nil {
				return false, 1
			}
			return false, 0
		case request, ok := <-requests:
			if !ok {
				return false, 6
			}
			switch request.Cmd {
			case svc.Interrogate:
				changes <- current
			case svc.Stop, svc.Shutdown:
				changes <- svc.Status{State: svc.StopPending}
				response, err := daemonSimpleRequest(service.endpoint, daemonrpc.TypeShutdown)
				if err != nil || response.Type != daemonrpc.TypeStopped {
					return false, 3
				}
				select {
				case err := <-done:
					if err != nil {
						return false, 4
					}
					return false, 0
				case <-time.After(30 * time.Second):
					return false, 5
				}
			default:
				changes <- current
			}
		}
	}
}
