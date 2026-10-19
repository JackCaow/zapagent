package main

import (
	"bytes"
	"context"
	"errors"
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"zapvm/internal/artifactstore"
	"zapvm/internal/cloudplane"
	"zapvm/internal/controlpostgres"
	"zapvm/internal/credential"
	"zapvm/internal/credentialkms"
	"zapvm/internal/githubapp"
	"zapvm/internal/nodeidentity"
	"zapvm/internal/remoteauth"
)

var version = "0.1.0-dev"

type controlMaintenance interface {
	Sweep() error
	ExpiredArtifactObjects(limit int) ([]cloudplane.Artifact, error)
	ConfirmArtifactObjectDeleted(id, objectKey string) error
}

func main() {
	if err := run(os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, "zapvm-control:", err)
		os.Exit(1)
	}
}

func run(args []string) (result error) {
	flags := flag.NewFlagSet("zapvm-control", flag.ContinueOnError)
	configPath := flags.String("config", "", "owner-only cloud control-plane JSON configuration")
	validateOnly := flags.Bool("validate", false, "validate configuration and mTLS authority without listening")
	repairPayloadDigests := flags.Bool("repair-payload-digests", false, "explicitly repair strict Task payload digests, then exit")
	showVersion := flags.Bool("version", false, "print version")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if flags.NArg() != 0 {
		return errors.New("zapvm-control accepts no positional arguments")
	}
	if *showVersion {
		fmt.Fprintln(os.Stdout, version)
		return nil
	}
	if *configPath == "" {
		return errors.New("zapvm-control requires --config")
	}
	config, err := cloudplane.LoadConfig(*configPath)
	if err != nil {
		return err
	}
	if *validateOnly && *repairPayloadDigests {
		return errors.New("zapvm-control validation and state repair are mutually exclusive")
	}
	if *repairPayloadDigests {
		repaired, err := cloudplane.RepairTaskPayloadDigests(config.StateRoot)
		if err != nil {
			return err
		}
		fmt.Fprintf(os.Stdout, "repaired_task_payload_digests=%d\n", repaired)
		return nil
	}
	tlsConfig, err := remoteauth.LoadMutualTLSServerWithOptionalClient(
		config.ClientCA, config.Certificate, config.PrivateKey, config.ControlURI(), config.NodeIdentity != nil,
	)
	if err != nil {
		return err
	}
	var artifactObjects cloudplane.ArtifactObjectStore
	if config.ArtifactStore != nil {
		artifactObjects, err = artifactstore.Open(*config.ArtifactStore)
		if err != nil {
			return err
		}
	}
	gitProviders, err := githubapp.Open(config.GitHubApps, nil, time.Now)
	if err != nil {
		return err
	}
	var credentialEnvelopeBroker *credentialkms.Broker
	var staticCredentialWrapper *credentialkms.StaticKeyWrapper
	if config.CredentialBroker != nil {
		key, readErr := remoteauth.ReadOwnerOnlyFile(config.CredentialBroker.DevelopmentStaticKeyFile, credentialkms.DataKeySize)
		if readErr != nil || len(key) != credentialkms.DataKeySize {
			credential.ZeroBytes(key)
			return errors.New("load development Credential wrapper key")
		}
		staticCredentialWrapper, err = credentialkms.NewStaticKeyWrapper(key, "local/credential-kek", "v1")
		credential.ZeroBytes(key)
		if err != nil {
			return err
		}
		defer staticCredentialWrapper.Close()
		credentialEnvelopeBroker, err = credentialkms.New(staticCredentialWrapper)
		if err != nil {
			return err
		}
	}
	var nodeIdentityAuthority *nodeidentity.Authority
	if config.NodeIdentity != nil {
		nodeIdentityAuthority, err = nodeidentity.Load(config.NodeIdentity.SigningCertificateFile, config.NodeIdentity.SigningPrivateKeyFile, time.Now)
		if err != nil {
			return err
		}
		if err := remoteauth.VerifyCertificateAuthorityTrust(config.ClientCA, config.NodeIdentity.SigningCertificateFile); err != nil {
			return err
		}
	}
	if *validateOnly {
		postgresMode := "disabled"
		if config.PostgreSQLMirror != nil {
			postgresMode = "mirror"
		} else if config.PostgreSQLPrimary != nil {
			postgresMode = config.PostgreSQLPrimary.Mode
		}
		fmt.Fprintf(os.Stdout, "schema=1 control_uri=%s nodes=%d artifact_store=%t github_apps=%d credential_broker=%t node_identity=%t postgresql_mode=%s\n", config.ControlURI(), len(config.Nodes), artifactObjects != nil, len(config.GitHubApps), credentialEnvelopeBroker != nil, nodeIdentityAuthority != nil, postgresMode)
		return nil
	}
	storeOptions := config.StoreOptions()
	var postgresDatabase *controlpostgres.Migrator
	var postgresMirror *controlpostgres.OnlineMirror
	var postgresPrimary *controlpostgres.Primary
	var postgresBackend *controlpostgres.Backend
	if config.PostgreSQLMirror != nil {
		postgresDatabase, postgresMirror, err = openPostgreSQLMirror(*config.PostgreSQLMirror)
		if err != nil {
			return err
		}
		storeOptions.StateMirror = postgresMirror
		storeOptions.StateMirrorTimeout = time.Duration(config.PostgreSQLMirror.FlushTimeoutSeconds) * time.Second
	} else if config.PostgreSQLPrimary != nil {
		if config.PostgreSQLPrimary.Mode == "distributed" {
			postgresDatabase, err = openPostgreSQLDatabase(config.PostgreSQLPrimary.DSNFile, config.PostgreSQLPrimary.OperationTimeoutSeconds, config.PostgreSQLPrimary.DevelopmentInsecureLocalhost)
			if err != nil {
				return err
			}
			openContext, cancel := context.WithTimeout(context.Background(), time.Duration(config.PostgreSQLPrimary.OperationTimeoutSeconds)*time.Second)
			postgresBackend, err = controlpostgres.NewBackend(openContext, postgresDatabase, controlpostgres.BackendOptions{
				OperationTimeout: time.Duration(config.PostgreSQLPrimary.OperationTimeoutSeconds) * time.Second,
				Queue: controlpostgres.QueueOptions{
					HeartbeatTTL:         time.Duration(config.HeartbeatTTLSeconds) * time.Second,
					LeaseTTL:             time.Duration(config.LeaseTTLSeconds) * time.Second,
					DispatchTimeout:      time.Duration(config.DispatchTimeoutSeconds) * time.Second,
					PlacementMode:        config.PostgreSQLPrimary.PlacementMode,
					ComputerStartTimeout: time.Duration(config.PostgreSQLPrimary.ComputerStartTimeoutSeconds) * time.Second,
					ArtifactBytesPerTask: config.ArtifactBytesPerTask, ArtifactBytesPerScope: config.ArtifactBytesPerScope,
					CredentialBroker:        credentialEnvelopeBroker,
					CredentialCapabilityTTL: credentialCapabilityTTL(config),
				},
				Provisions: config.Nodes,
			})
			cancel()
			if err != nil {
				postgresDatabase.Close()
				return err
			}
		} else {
			postgresDatabase, postgresPrimary, err = openPostgreSQLPrimary(*config.PostgreSQLPrimary)
			if err != nil {
				return err
			}
			storeOptions.StatePrimary = postgresPrimary
			storeOptions.StatePrimaryTimeout = time.Duration(config.PostgreSQLPrimary.OperationTimeoutSeconds) * time.Second
		}
	}
	if postgresDatabase != nil {
		defer postgresDatabase.Close()
	}
	if nodeIdentityAuthority != nil {
		if postgresBackend == nil {
			return errors.New("Node identity authority requires distributed PostgreSQL Backend")
		}
		provisions := make([]nodeidentity.EnrollmentProvision, 0, len(config.NodeIdentity.EnrollmentTokens))
		for _, provision := range config.NodeIdentity.EnrollmentTokens {
			digest, parseErr := nodeidentity.ParseTokenSHA256(provision.TokenSHA256)
			if parseErr != nil {
				return parseErr
			}
			expiresAt, _ := time.Parse(time.RFC3339, provision.ExpiresAt)
			provisions = append(provisions, nodeidentity.EnrollmentProvision{NodeID: provision.NodeID, TokenSHA256: digest, ExpiresAt: expiresAt})
		}
		if err := postgresBackend.ProvisionNodeEnrollmentTokens(provisions); err != nil {
			return err
		}
	}
	var backend cloudplane.Backend
	var maintenance controlMaintenance
	if postgresBackend != nil {
		backend = postgresBackend
		maintenance = postgresBackend
	} else {
		store, openErr := cloudplane.Open(config.StateRoot, config.Nodes, storeOptions)
		if openErr != nil {
			if postgresMirror != nil {
				closeContext, cancel := context.WithTimeout(context.Background(), storeOptions.StateMirrorTimeout)
				_ = postgresMirror.Close(closeContext)
				cancel()
			}
			return openErr
		}
		defer func() { result = errors.Join(result, store.Close()) }()
		backend = store
		maintenance = store
	}
	api, err := cloudplane.NewAPIWithDependencies(backend, config.TrustDomain, config.Administrators, artifactObjects, gitProviders, log.New(os.Stderr, "", log.LstdFlags|log.LUTC))
	if err != nil {
		return err
	}
	if nodeIdentityAuthority != nil {
		if err := api.EnableNodeIdentity(nodeIdentityAuthority, time.Duration(config.NodeIdentity.CertificateTTLSeconds)*time.Second); err != nil {
			return err
		}
	}
	listener, err := net.Listen("tcp", config.Listen)
	if err != nil {
		return err
	}
	defer listener.Close()
	tlsListener := tlsNewListener(listener, tlsConfig)
	server := &http.Server{
		Handler: api.Handler(), ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 2 * time.Hour,
		WriteTimeout: 2 * time.Hour, IdleTimeout: 2 * time.Minute, MaxHeaderBytes: 16 << 10,
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	serveErrors := make(chan error, 1)
	go func() { serveErrors <- server.Serve(tlsListener) }()
	sweepDone := make(chan struct{})
	go func() {
		defer close(sweepDone)
		ticker := time.NewTicker(5 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ticker.C:
				if err := maintenance.Sweep(); err != nil {
					serveErrors <- fmt.Errorf("control-plane sweep: %w", err)
					return
				}
				if artifactObjects != nil {
					gcContext, cancel := context.WithTimeout(ctx, 30*time.Second)
					candidates, gcErr := maintenance.ExpiredArtifactObjects(100)
					for _, artifact := range candidates {
						if gcErr = artifactObjects.Delete(gcContext, artifact.ObjectKey); gcErr != nil {
							break
						}
						if gcErr = maintenance.ConfirmArtifactObjectDeleted(artifact.ID, artifact.ObjectKey); gcErr != nil {
							break
						}
					}
					cancel()
					if gcErr != nil && !errors.Is(gcErr, context.Canceled) {
						fmt.Fprintf(os.Stderr, "zapVM Artifact GC retrying after error: %v\n", gcErr)
					}
				}
			case <-ctx.Done():
				return
			}
		}
	}()
	fmt.Fprintf(os.Stderr, "zapVM cloud control plane listening on %s as %s\n", listener.Addr(), config.ControlURI())
	select {
	case err := <-serveErrors:
		stop()
		_ = server.Close()
		<-sweepDone
		if errors.Is(err, http.ErrServerClosed) {
			return nil
		}
		return err
	case <-ctx.Done():
		shutdownContext, cancel := context.WithTimeout(context.Background(), 20*time.Second)
		defer cancel()
		err := server.Shutdown(shutdownContext)
		<-sweepDone
		serveErr := <-serveErrors
		if errors.Is(serveErr, http.ErrServerClosed) {
			serveErr = nil
		}
		return errors.Join(err, serveErr)
	}
}

func openPostgreSQLMirror(config cloudplane.PostgreSQLMirrorConfig) (*controlpostgres.Migrator, *controlpostgres.OnlineMirror, error) {
	database, err := openPostgreSQLDatabase(config.DSNFile, config.FlushTimeoutSeconds, config.DevelopmentInsecureLocalhost)
	if err != nil {
		return nil, nil, err
	}
	mirror, err := controlpostgres.NewOnlineMirror(database, controlpostgres.OnlineMirrorOptions{RetryInterval: time.Duration(config.RetryIntervalSeconds) * time.Second})
	if err != nil {
		database.Close()
		return nil, nil, err
	}
	return database, mirror, nil
}

func openPostgreSQLPrimary(config cloudplane.PostgreSQLPrimaryConfig) (*controlpostgres.Migrator, *controlpostgres.Primary, error) {
	database, err := openPostgreSQLDatabase(config.DSNFile, config.OperationTimeoutSeconds, config.DevelopmentInsecureLocalhost)
	if err != nil {
		return nil, nil, err
	}
	primary, err := controlpostgres.NewPrimary(database)
	if err != nil {
		database.Close()
		return nil, nil, err
	}
	return database, primary, nil
}

func credentialCapabilityTTL(config cloudplane.Config) time.Duration {
	if config.CredentialBroker == nil {
		return 0
	}
	return time.Duration(config.CredentialBroker.CapabilityTTLSeconds) * time.Second
}

func openPostgreSQLDatabase(dsnFile string, timeoutSeconds uint32, allowInsecureLocalhost bool) (*controlpostgres.Migrator, error) {
	data, err := remoteauth.ReadOwnerOnlyFile(dsnFile, 8192)
	if err != nil {
		return nil, errors.New("load PostgreSQL State DSN file")
	}
	dsnBytes := bytes.TrimSpace(data)
	if len(dsnBytes) == 0 || bytes.IndexByte(dsnBytes, 0) >= 0 {
		zeroBytes(data)
		return nil, errors.New("PostgreSQL State DSN file is empty or invalid")
	}
	dsn := string(dsnBytes)
	openTimeout := time.Duration(timeoutSeconds) * time.Second
	ctx, cancel := context.WithTimeout(context.Background(), openTimeout)
	database, openErr := controlpostgres.Open(ctx, dsn, controlpostgres.OpenOptions{AllowInsecureLocalhost: allowInsecureLocalhost})
	cancel()
	dsn = ""
	zeroBytes(data)
	if openErr != nil {
		return nil, openErr
	}
	return database, nil
}

func zeroBytes(data []byte) {
	for index := range data {
		data[index] = 0
	}
}
