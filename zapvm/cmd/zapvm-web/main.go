package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"zapvm/internal/webbff"
)

var version = "0.1.0-dev"

func main() {
	if err := run(os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, "zapvm-web:", err)
		os.Exit(1)
	}
}

func run(args []string) error {
	flags := flag.NewFlagSet("zapvm-web", flag.ContinueOnError)
	configPath := flags.String("config", "", "owner-only Web BFF JSON configuration")
	validateOnly := flags.Bool("validate", false, "validate configuration, signing key, and mTLS projects")
	issueInvite := flags.Bool("issue-invite", false, "print a time-limited Workspace invitation URL")
	inviteProject := flags.String("invite-project", "", "Project ID for --issue-invite")
	inviteUser := flags.String("invite-user", "", "canonical user ID for --issue-invite")
	inviteTTL := flags.Duration("invite-ttl", 24*time.Hour, "invitation lifetime between 5m and 168h")
	showVersion := flags.Bool("version", false, "print version")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if flags.NArg() != 0 {
		return errors.New("zapvm-web accepts no positional arguments")
	}
	if *showVersion {
		fmt.Fprintln(os.Stdout, version)
		return nil
	}
	if *configPath == "" {
		return errors.New("zapvm-web requires --config")
	}
	config, err := webbff.LoadConfig(*configPath)
	if err != nil {
		return err
	}
	signingKey, projects, err := config.Build()
	if err != nil {
		return err
	}
	if *issueInvite {
		var projectExists bool
		for _, project := range projects {
			if project.ID == *inviteProject {
				projectExists = true
				break
			}
		}
		if !projectExists {
			return errors.New("invite Project is not configured")
		}
		inviteURL, err := webbff.IssueInviteURL(signingKey, config.PublicOrigin, *inviteProject, *inviteUser, time.Now(), *inviteTTL)
		if err != nil {
			return err
		}
		fmt.Fprintln(os.Stdout, inviteURL)
		return nil
	}
	if *validateOnly {
		fmt.Fprintf(os.Stdout, "schema=1 projects=%d public_origin=%s\n", len(projects), config.PublicOrigin)
		return nil
	}
	logger := log.New(os.Stderr, "", log.LstdFlags|log.LUTC)
	web, err := webbff.New(config, signingKey, projects, logger)
	if err != nil {
		return err
	}
	server := &http.Server{
		Addr: config.Listen, Handler: web.Handler(), ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 15 * time.Second,
		WriteTimeout: 35 * time.Second, IdleTimeout: 2 * time.Minute, MaxHeaderBytes: 16 << 10,
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	errorsChannel := make(chan error, 1)
	go func() { errorsChannel <- server.ListenAndServe() }()
	logger.Printf("component=web_bff listen=%s projects=%d", config.Listen, len(projects))
	select {
	case err := <-errorsChannel:
		if errors.Is(err, http.ErrServerClosed) {
			return nil
		}
		return err
	case <-ctx.Done():
		shutdownContext, cancel := context.WithTimeout(context.Background(), 20*time.Second)
		defer cancel()
		err := server.Shutdown(shutdownContext)
		serveErr := <-errorsChannel
		if errors.Is(serveErr, http.ErrServerClosed) {
			serveErr = nil
		}
		return errors.Join(err, serveErr)
	}
}
