package cloudplane

import (
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"zapvm/internal/credential"
	"zapvm/internal/daemonrpc"
	"zapvm/internal/gitprovider"
	"zapvm/internal/nodeidentity"
	"zapvm/internal/remoteauth"
)

const maxAPIRequestSize = MaxPayloadSize + 64<<10

type API struct {
	store              Backend
	trustDomain        string
	administrators     map[string]struct{}
	requests           chan struct{}
	logger             *log.Logger
	metrics            *apiMetrics
	artifactStore      ArtifactObjectStore
	gitProviders       gitprovider.Issuer
	nodeAuthority      *nodeidentity.Authority
	nodeCertificateTTL time.Duration
	artifactUploads    [64]sync.Mutex
}

func NewAPI(store Backend, trustDomain string, administrators []string) (*API, error) {
	return NewAPIWithLogger(store, trustDomain, administrators, log.New(io.Discard, "", 0))
}

func NewAPIWithLogger(store Backend, trustDomain string, administrators []string, logger *log.Logger) (*API, error) {
	return NewAPIWithArtifactStore(store, trustDomain, administrators, nil, logger)
}

func NewAPIWithArtifactStore(store Backend, trustDomain string, administrators []string, artifactStore ArtifactObjectStore, logger *log.Logger) (*API, error) {
	return NewAPIWithDependencies(store, trustDomain, administrators, artifactStore, nil, logger)
}

func NewAPIWithDependencies(store Backend, trustDomain string, administrators []string, artifactStore ArtifactObjectStore, gitProviders gitprovider.Issuer, logger *log.Logger) (*API, error) {
	if store == nil || !validTrustDomain(trustDomain) {
		return nil, errors.New("cloud control-plane API requires a store and trust domain")
	}
	if logger == nil {
		return nil, errors.New("cloud control-plane API requires a logger")
	}
	adminSet := make(map[string]struct{}, len(administrators))
	for _, principal := range administrators {
		identity, err := remoteauth.ParseClientIdentity(principal, trustDomain)
		if err != nil {
			return nil, err
		}
		adminSet[identity.URI] = struct{}{}
	}
	if len(adminSet) == 0 {
		return nil, errors.New("cloud control-plane API requires an administrator")
	}
	return &API{
		store: store, trustDomain: trustDomain, administrators: adminSet,
		requests: make(chan struct{}, 256), logger: logger, metrics: newAPIMetrics(), artifactStore: artifactStore, gitProviders: gitProviders,
	}, nil
}

func (api *API) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", api.health)
	mux.HandleFunc("/readyz", api.ready)
	mux.HandleFunc("/v1/node/register", api.nodeRegister)
	mux.HandleFunc("/v1/node/enroll", api.nodeEnroll)
	mux.HandleFunc("/v1/node/certificate/renew", api.nodeCertificateRenew)
	mux.HandleFunc("/v1/node/heartbeat", api.nodeHeartbeat)
	mux.HandleFunc("/v1/node/cancellations", api.nodeCancellations)
	mux.HandleFunc("/v1/node/claim", api.nodeClaim)
	mux.HandleFunc("/v1/node/computers/claim", api.nodeComputerClaim)
	mux.HandleFunc("/v1/node/computers/operations/", api.nodeComputerOperation)
	mux.HandleFunc("/v1/node/tasks/", api.nodeTask)
	mux.HandleFunc("/v1/node/workspace/claim", api.nodeWorkspaceClaim)
	mux.HandleFunc("/v1/node/workspace/operations/", api.nodeWorkspaceOperation)
	mux.HandleFunc("/v1/tasks", api.tasks)
	mux.HandleFunc("/v1/tasks/", api.task)
	mux.HandleFunc("/v1/agent/sessions", api.agentSessions)
	mux.HandleFunc("/v1/agent/sessions/", api.agentSession)
	mux.HandleFunc("/v1/agent/artifacts/", api.agentArtifact)
	mux.HandleFunc("/v1/agent/credentials", api.agentCredentials)
	mux.HandleFunc("/v1/agent/credentials/", api.agentCredential)
	mux.HandleFunc("/v1/agent/computers", api.agentComputers)
	mux.HandleFunc("/v1/agent/computers/", api.agentComputerWorkspace)
	mux.HandleFunc("/v1/agent/git/providers", api.agentGitProviders)
	mux.HandleFunc("/v1/audit", api.audit)
	mux.HandleFunc("/v1/admin/nodes", api.adminNodes)
	mux.HandleFunc("/v1/admin/nodes/", api.adminNode)
	mux.HandleFunc("/v1/admin/metrics", api.adminMetrics)
	mux.HandleFunc("/v1/workspace/me", api.workspaceMe)
	mux.HandleFunc("/v1/workspace/members", api.workspaceMembers)
	mux.HandleFunc("/v1/workspace/members/", api.workspaceMember)
	mux.HandleFunc("/v1/workspace/host-pools", api.workspaceHostPools)
	mux.HandleFunc("/v1/workspace/host-pools/", api.workspaceHostPool)
	mux.HandleFunc("/v1/workspace/nodes", api.workspaceNodes)
	mux.HandleFunc("/v1/workspace/nodes/", api.workspaceNode)
	mux.HandleFunc("/v1/workspace/models", api.workspaceModels)
	mux.HandleFunc("/v1/workspace/models/", api.workspaceModel)
	mux.HandleFunc("/v1/workspace/agents", api.workspaceAgents)
	mux.HandleFunc("/v1/workspace/agents/", api.workspaceAgent)
	mux.HandleFunc("/v1/workspace/computers", api.workspaceComputers)
	mux.HandleFunc("/v1/workspace/computers/", api.workspaceComputer)
	mux.HandleFunc("/v1/workspace/quota", api.workspaceQuota)
	mux.HandleFunc("/v1/workspace/usage", api.workspaceUsage)
	mux.HandleFunc("/v1/workspace/runtime", api.workspaceRuntime)
	mux.HandleFunc("/v1/workspace/credentials", api.workspaceCredentials)
	mux.HandleFunc("/v1/workspace/credentials/", api.workspaceCredential)
	return api.observeRequests(api.limitRequests(securityHeaders(mux)))
}

func (api *API) EnableNodeIdentity(authority *nodeidentity.Authority, ttl time.Duration) error {
	if authority == nil || ttl < 5*time.Minute || ttl > 24*time.Hour {
		return errors.New("cloud control-plane Node identity authority is invalid")
	}
	if _, ok := api.store.(NodeIdentityBackend); !ok {
		return errors.New("cloud control-plane Backend has no Node identity ledger")
	}
	api.nodeAuthority = authority
	api.nodeCertificateTTL = ttl
	return nil
}

type nodeCertificateRequest struct {
	CSR []byte `json:"csr"`
}

type nodeEnrollmentRequest struct {
	NodeID string `json:"node_id"`
	Token  []byte `json:"token"`
	CSR    []byte `json:"csr"`
}

type nodeCertificateResponse struct {
	Certificate []byte `json:"certificate"`
	SerialHex   string `json:"serial_hex"`
	NotBefore   string `json:"not_before"`
	NotAfter    string `json:"not_after"`
}

func (api *API) nodeEnroll(writer http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodPost {
		writeAPIError(writer, http.StatusMethodNotAllowed, "method_not_allowed")
		return
	}
	backend, ok := api.store.(NodeIdentityBackend)
	if api.nodeAuthority == nil || !ok {
		writeAPIError(writer, http.StatusNotFound, "not_found")
		return
	}
	var body nodeEnrollmentRequest
	if err := decodeAPIRequest(writer, request, &body); err != nil {
		credential.ZeroBytes(body.Token)
		credential.ZeroBytes(body.CSR)
		writeAPIError(writer, http.StatusBadRequest, "invalid_request")
		return
	}
	defer credential.ZeroBytes(body.Token)
	defer credential.ZeroBytes(body.CSR)
	if len(body.Token) < 32 || len(body.Token) > 4096 {
		writeAPIError(writer, http.StatusForbidden, "node_enrollment_required")
		return
	}
	issued, err := api.nodeAuthority.Issue(request.Context(), "spiffe://"+api.trustDomain+"/node/"+body.NodeID, body.CSR, api.nodeCertificateTTL)
	if err != nil {
		writeAPIError(writer, http.StatusBadRequest, "invalid_request")
		return
	}
	record := issuedNodeCertificateRecord(body.NodeID, issued, "")
	if err := backend.EnrollNodeCertificate(body.NodeID, body.Token, record); err != nil {
		writeStoreError(writer, err)
		return
	}
	writeJSON(writer, http.StatusCreated, publicNodeCertificate(issued))
}

func (api *API) nodeCertificateRenew(writer http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodPost {
		writeAPIError(writer, http.StatusMethodNotAllowed, "method_not_allowed")
		return
	}
	backend, ok := api.store.(NodeIdentityBackend)
	if api.nodeAuthority == nil || !ok {
		writeAPIError(writer, http.StatusNotFound, "not_found")
		return
	}
	nodeID, err := api.nodeIdentity(request)
	if err != nil {
		writeAPIError(writer, http.StatusForbidden, "node_identity_required")
		return
	}
	currentSerial, err := requestCertificateSerial(request)
	if err != nil {
		writeAPIError(writer, http.StatusForbidden, "node_identity_required")
		return
	}
	var body nodeCertificateRequest
	if err := decodeAPIRequest(writer, request, &body); err != nil {
		credential.ZeroBytes(body.CSR)
		writeAPIError(writer, http.StatusBadRequest, "invalid_request")
		return
	}
	defer credential.ZeroBytes(body.CSR)
	issued, err := api.nodeAuthority.Issue(request.Context(), "spiffe://"+api.trustDomain+"/node/"+nodeID, body.CSR, api.nodeCertificateTTL)
	if err != nil {
		writeAPIError(writer, http.StatusBadRequest, "invalid_request")
		return
	}
	if err := backend.RenewNodeCertificate(nodeID, currentSerial, issuedNodeCertificateRecord(nodeID, issued, currentSerial)); err != nil {
		writeStoreError(writer, err)
		return
	}
	writeJSON(writer, http.StatusCreated, publicNodeCertificate(issued))
}

func issuedNodeCertificateRecord(nodeID string, issued nodeidentity.IssuedCertificate, renewedFrom string) nodeidentity.CertificateRecord {
	return nodeidentity.CertificateRecord{NodeID: nodeID, SerialHex: issued.SerialHex, PublicKeySHA256: issued.PublicKeySHA256,
		IssuedAt: issued.NotBefore.Add(time.Minute), NotBefore: issued.NotBefore, NotAfter: issued.NotAfter, RenewedFromSerialHex: renewedFrom}
}

func publicNodeCertificate(issued nodeidentity.IssuedCertificate) nodeCertificateResponse {
	return nodeCertificateResponse{Certificate: issued.CertificatePEM, SerialHex: issued.SerialHex,
		NotBefore: issued.NotBefore.UTC().Format(time.RFC3339Nano), NotAfter: issued.NotAfter.UTC().Format(time.RFC3339Nano)}
}

func (api *API) agentGitProviders(writer http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodGet {
		writeAPIError(writer, http.StatusMethodNotAllowed, "method_not_allowed")
		return
	}
	identity, err := api.clientIdentity(request)
	if err != nil {
		writeAPIError(writer, http.StatusForbidden, "client_identity_required")
		return
	}
	providers := []gitprovider.Descriptor{}
	if api.gitProviders != nil {
		providers = api.gitProviders.List(identity.TenantID, identity.ProjectID)
	}
	writeJSON(writer, http.StatusOK, map[string]any{"providers": providers})
}

func (api *API) health(writer http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodGet {
		writeAPIError(writer, http.StatusMethodNotAllowed, "method_not_allowed")
		return
	}
	if _, err := api.principal(request); err != nil {
		writeAPIError(writer, http.StatusUnauthorized, "mutual_tls_required")
		return
	}
	writeJSON(writer, http.StatusOK, map[string]any{"schema_version": 1, "status": "ok"})
}

func (api *API) ready(writer http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodGet {
		writeAPIError(writer, http.StatusMethodNotAllowed, "method_not_allowed")
		return
	}
	if _, err := api.principal(request); err != nil {
		writeAPIError(writer, http.StatusUnauthorized, "mutual_tls_required")
		return
	}
	if err := api.store.Ready(); err != nil {
		writeStoreError(writer, err)
		return
	}
	writeJSON(writer, http.StatusOK, map[string]any{"schema_version": 1, "status": "ready"})
}

type nodeRegisterRequest struct {
	Generation               string                  `json:"generation"`
	NodeVersion              string                  `json:"node_version,omitempty"`
	DaemonVersion            string                  `json:"daemon_version,omitempty"`
	ImageDigest              string                  `json:"image_digest,omitempty"`
	DaemonState              string                  `json:"daemon_state,omitempty"`
	FailureCode              string                  `json:"failure_code,omitempty"`
	StartAttempts            uint64                  `json:"start_attempts"`
	StartFailures            uint64                  `json:"start_failures"`
	StartDurationMillisTotal uint64                  `json:"start_duration_ms_total"`
	StartDurationMillisMax   uint64                  `json:"start_duration_ms_max"`
	ComputerRuntimes         []ComputerRuntimeReport `json:"computer_runtimes,omitempty"`
}

func (request nodeRegisterRequest) report() NodeReport {
	return NodeReport{
		NodeVersion: request.NodeVersion, DaemonVersion: request.DaemonVersion,
		ImageDigest: request.ImageDigest, DaemonState: request.DaemonState, FailureCode: request.FailureCode,
		StartAttempts: request.StartAttempts, StartFailures: request.StartFailures,
		StartDurationMillisTotal: request.StartDurationMillisTotal, StartDurationMillisMax: request.StartDurationMillisMax,
		ComputerRuntimes: append([]ComputerRuntimeReport(nil), request.ComputerRuntimes...),
	}
}

func (api *API) nodeRegister(writer http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodPost {
		writeAPIError(writer, http.StatusMethodNotAllowed, "method_not_allowed")
		return
	}
	nodeID, err := api.nodeIdentity(request)
	if err != nil {
		writeAPIError(writer, http.StatusForbidden, "node_identity_required")
		return
	}
	var body nodeRegisterRequest
	if err := decodeAPIRequest(writer, request, &body); err != nil {
		writeAPIError(writer, http.StatusBadRequest, "invalid_request")
		return
	}
	node, err := api.store.RegisterNodeWithReport(nodeID, body.Generation, body.report())
	if err != nil {
		writeStoreError(writer, err)
		return
	}
	writeJSON(writer, http.StatusOK, node)
}

type nodeHeartbeatRequest struct {
	Generation               string                  `json:"generation"`
	Leases                   []LeaseProof            `json:"leases,omitempty"`
	NodeVersion              string                  `json:"node_version,omitempty"`
	DaemonVersion            string                  `json:"daemon_version,omitempty"`
	ImageDigest              string                  `json:"image_digest,omitempty"`
	DaemonState              string                  `json:"daemon_state,omitempty"`
	FailureCode              string                  `json:"failure_code,omitempty"`
	StartAttempts            uint64                  `json:"start_attempts"`
	StartFailures            uint64                  `json:"start_failures"`
	StartDurationMillisTotal uint64                  `json:"start_duration_ms_total"`
	StartDurationMillisMax   uint64                  `json:"start_duration_ms_max"`
	ComputerRuntimes         []ComputerRuntimeReport `json:"computer_runtimes,omitempty"`
}

func (request nodeHeartbeatRequest) report() NodeReport {
	return NodeReport{
		NodeVersion: request.NodeVersion, DaemonVersion: request.DaemonVersion,
		ImageDigest: request.ImageDigest, DaemonState: request.DaemonState, FailureCode: request.FailureCode,
		StartAttempts: request.StartAttempts, StartFailures: request.StartFailures,
		StartDurationMillisTotal: request.StartDurationMillisTotal, StartDurationMillisMax: request.StartDurationMillisMax,
		ComputerRuntimes: append([]ComputerRuntimeReport(nil), request.ComputerRuntimes...),
	}
}

func (api *API) nodeHeartbeat(writer http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodPost {
		writeAPIError(writer, http.StatusMethodNotAllowed, "method_not_allowed")
		return
	}
	nodeID, err := api.nodeIdentity(request)
	if err != nil {
		writeAPIError(writer, http.StatusForbidden, "node_identity_required")
		return
	}
	var body nodeHeartbeatRequest
	if err := decodeAPIRequest(writer, request, &body); err != nil {
		writeAPIError(writer, http.StatusBadRequest, "invalid_request")
		return
	}
	node, err := api.store.HeartbeatWithReport(nodeID, body.Generation, body.Leases, body.report())
	if err != nil {
		writeStoreError(writer, err)
		return
	}
	writeJSON(writer, http.StatusOK, node)
}

func (api *API) nodeCancellations(writer http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodPost {
		writeAPIError(writer, http.StatusMethodNotAllowed, "method_not_allowed")
		return
	}
	nodeID, err := api.nodeIdentity(request)
	if err != nil {
		writeAPIError(writer, http.StatusForbidden, "node_identity_required")
		return
	}
	var body nodeHeartbeatRequest
	if err := decodeAPIRequest(writer, request, &body); err != nil {
		writeAPIError(writer, http.StatusBadRequest, "invalid_request")
		return
	}
	taskIDs, err := api.store.Cancellations(nodeID, body.Generation, body.Leases)
	if err != nil {
		writeStoreError(writer, err)
		return
	}
	writeJSON(writer, http.StatusOK, map[string]any{"task_ids": taskIDs})
}

type nodeClaimRequest struct {
	Generation string `json:"generation"`
	Maximum    int    `json:"maximum"`
}

func (api *API) nodeClaim(writer http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodPost {
		writeAPIError(writer, http.StatusMethodNotAllowed, "method_not_allowed")
		return
	}
	nodeID, err := api.nodeIdentity(request)
	if err != nil {
		writeAPIError(writer, http.StatusForbidden, "node_identity_required")
		return
	}
	var body nodeClaimRequest
	if err := decodeAPIRequest(writer, request, &body); err != nil {
		writeAPIError(writer, http.StatusBadRequest, "invalid_request")
		return
	}
	leases, err := api.store.Claim(nodeID, body.Generation, body.Maximum)
	if err != nil {
		if errors.Is(err, ErrCapacityReached) {
			writeJSON(writer, http.StatusOK, map[string]any{"leases": []Lease{}})
			return
		}
		writeStoreError(writer, err)
		return
	}
	for index := range leases {
		leases[index].Task.LeaseTokenHash = ""
	}
	writeJSON(writer, http.StatusOK, map[string]any{"leases": leases})
}

type nodeAckRequest struct {
	Generation string `json:"generation"`
	LeaseToken string `json:"lease_token"`
}

type nodeCompleteRequest struct {
	Generation   string `json:"generation"`
	LeaseToken   string `json:"lease_token"`
	Succeeded    bool   `json:"succeeded"`
	ResultSHA256 string `json:"result_sha256,omitempty"`
	FailureCode  string `json:"failure_code,omitempty"`
}

type nodeEventRequest struct {
	Generation string                      `json:"generation"`
	LeaseToken string                      `json:"lease_token"`
	Event      daemonrpc.ComputerTaskEvent `json:"event"`
}

type nodeArtifactRequest struct {
	Generation string                      `json:"generation"`
	LeaseToken string                      `json:"lease_token"`
	Artifact   ArtifactRegistrationRequest `json:"artifact"`
}

type nodeCredentialRedeemRequest struct {
	Generation string               `json:"generation"`
	LeaseToken string               `json:"lease_token"`
	Capability CredentialCapability `json:"capability"`
}

func (api *API) nodeTask(writer http.ResponseWriter, request *http.Request) {
	nodeID, err := api.nodeIdentity(request)
	if err != nil {
		writeAPIError(writer, http.StatusForbidden, "node_identity_required")
		return
	}
	remainder := strings.TrimPrefix(request.URL.Path, "/v1/node/tasks/")
	parts := strings.Split(remainder, "/")
	if len(parts) == 4 && parts[0] != "" && parts[1] == "artifacts" && parts[2] != "" && parts[3] == "content" {
		api.nodeArtifactContent(writer, request, nodeID, parts[0], parts[2])
		return
	}
	if len(parts) != 2 || parts[0] == "" {
		writeAPIError(writer, http.StatusNotFound, "not_found")
		return
	}
	taskID, action := parts[0], parts[1]
	if action == "relay" {
		api.nodeTaskRelay(writer, request, nodeID, taskID)
		return
	}
	if request.Method != http.MethodPost {
		writeAPIError(writer, http.StatusMethodNotAllowed, "method_not_allowed")
		return
	}
	switch action {
	case "ack":
		var body nodeAckRequest
		if err := decodeAPIRequest(writer, request, &body); err != nil {
			writeAPIError(writer, http.StatusBadRequest, "invalid_request")
			return
		}
		task, err := api.store.Acknowledge(nodeID, body.Generation, taskID, body.LeaseToken)
		if err != nil {
			writeStoreError(writer, err)
			return
		}
		writeJSON(writer, http.StatusOK, redactTask(task))
	case "complete":
		var body nodeCompleteRequest
		if err := decodeAPIRequest(writer, request, &body); err != nil {
			writeAPIError(writer, http.StatusBadRequest, "invalid_request")
			return
		}
		task, err := api.store.Complete(nodeID, body.Generation, taskID, body.LeaseToken, Completion{
			Succeeded: body.Succeeded, ResultSHA256: body.ResultSHA256, FailureCode: body.FailureCode,
		})
		if err != nil {
			writeStoreError(writer, err)
			return
		}
		writeJSON(writer, http.StatusOK, redactTask(task))
	case "events":
		var body nodeEventRequest
		if err := decodeAPIRequest(writer, request, &body); err != nil {
			writeAPIError(writer, http.StatusBadRequest, "invalid_request")
			return
		}
		event, created, err := api.store.AppendTaskEvent(nodeID, body.Generation, taskID, body.LeaseToken, body.Event)
		if err != nil {
			writeStoreError(writer, err)
			return
		}
		status := http.StatusOK
		if created {
			status = http.StatusCreated
		}
		writeJSON(writer, status, event)
	case "artifacts":
		var body nodeArtifactRequest
		if err := decodeAPIRequest(writer, request, &body); err != nil {
			writeAPIError(writer, http.StatusBadRequest, "invalid_request")
			return
		}
		artifact, created, err := api.store.RegisterArtifact(nodeID, body.Generation, taskID, body.LeaseToken, body.Artifact)
		if err != nil {
			writeStoreError(writer, err)
			return
		}
		status := http.StatusOK
		if created {
			status = http.StatusCreated
		}
		writeJSON(writer, status, publicAgentArtifact(artifact))
	case "credentials":
		var body nodeCredentialRedeemRequest
		if err := decodeAPIRequest(writer, request, &body); err != nil {
			body.Capability.Destroy()
			writeAPIError(writer, http.StatusBadRequest, "invalid_request")
			return
		}
		defer body.Capability.Destroy()
		credentials, ok := api.store.(CredentialBackend)
		if !ok {
			writeAPIError(writer, http.StatusServiceUnavailable, "unavailable")
			return
		}
		bundle, err := credentials.RedeemCredentialCapability(nodeID, body.Generation, taskID, body.LeaseToken, body.Capability)
		if err != nil {
			writeStoreError(writer, err)
			return
		}
		defer bundle.Destroy()
		writeJSON(writer, http.StatusOK, bundle)
	case "canceled":
		var body nodeAckRequest
		if err := decodeAPIRequest(writer, request, &body); err != nil {
			writeAPIError(writer, http.StatusBadRequest, "invalid_request")
			return
		}
		task, err := api.store.ConfirmCanceled(nodeID, body.Generation, taskID, body.LeaseToken)
		if err != nil {
			writeStoreError(writer, err)
			return
		}
		writeJSON(writer, http.StatusOK, redactTask(task))
	default:
		writeAPIError(writer, http.StatusNotFound, "not_found")
	}
}

type credentialPutRequest struct {
	Value []byte `json:"value"`
}

func (api *API) credentialBackend(writer http.ResponseWriter) (CredentialBackend, bool) {
	backend, ok := api.store.(CredentialBackend)
	if !ok {
		writeAPIError(writer, http.StatusServiceUnavailable, "unavailable")
	}
	return backend, ok
}

func (api *API) agentCredentials(writer http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodGet {
		writeAPIError(writer, http.StatusMethodNotAllowed, "method_not_allowed")
		return
	}
	identity, err := api.clientIdentity(request)
	if err != nil {
		writeAPIError(writer, http.StatusForbidden, "client_identity_required")
		return
	}
	backend, ok := api.credentialBackend(writer)
	if !ok {
		return
	}
	descriptors, err := backend.ListCredentials(Scope{TenantID: identity.TenantID, ProjectID: identity.ProjectID})
	if err != nil {
		writeStoreError(writer, err)
		return
	}
	writeJSON(writer, http.StatusOK, map[string]any{"credentials": descriptors})
}

func (api *API) agentCredential(writer http.ResponseWriter, request *http.Request) {
	identity, err := api.clientIdentity(request)
	if err != nil {
		writeAPIError(writer, http.StatusForbidden, "client_identity_required")
		return
	}
	id := strings.TrimPrefix(request.URL.Path, "/v1/agent/credentials/")
	if id == "" || strings.Contains(id, "/") {
		writeAPIError(writer, http.StatusNotFound, "not_found")
		return
	}
	backend, ok := api.credentialBackend(writer)
	if !ok {
		return
	}
	scope := Scope{TenantID: identity.TenantID, ProjectID: identity.ProjectID}
	var descriptor CredentialDescriptor
	switch request.Method {
	case http.MethodPut:
		var body credentialPutRequest
		if err := decodeAPIRequest(writer, request, &body); err != nil {
			credential.ZeroBytes(body.Value)
			writeAPIError(writer, http.StatusBadRequest, "invalid_request")
			return
		}
		defer credential.ZeroBytes(body.Value)
		descriptor, err = backend.PutCredential(identity.URI, scope, id, body.Value)
	case http.MethodDelete:
		descriptor, err = backend.RevokeCredential(identity.URI, scope, id)
	default:
		writeAPIError(writer, http.StatusMethodNotAllowed, "method_not_allowed")
		return
	}
	if err != nil {
		writeStoreError(writer, err)
		return
	}
	writeJSON(writer, http.StatusOK, descriptor)
}

func (api *API) nodeArtifactContent(writer http.ResponseWriter, request *http.Request, nodeID, taskID, artifactID string) {
	if request.Method != http.MethodPut {
		writeAPIError(writer, http.StatusMethodNotAllowed, "method_not_allowed")
		return
	}
	if api.artifactStore == nil {
		writeAPIError(writer, http.StatusServiceUnavailable, "unavailable")
		return
	}
	generation := request.Header.Get("X-ZapVM-Node-Generation")
	leaseToken := request.Header.Get("X-ZapVM-Lease-Token")
	artifact, upload, err := api.store.PrepareArtifactUpload(nodeID, generation, taskID, leaseToken, artifactID)
	if err != nil {
		writeStoreError(writer, err)
		return
	}
	if !upload {
		writeJSON(writer, http.StatusOK, publicAgentArtifact(artifact))
		return
	}
	if request.ContentLength < 0 || uint64(request.ContentLength) != artifact.Size || request.Header.Get("Content-Type") != artifact.ContentType ||
		request.Header.Get("X-ZapVM-Artifact-SHA256") != artifact.SHA256 {
		writeAPIError(writer, http.StatusBadRequest, "invalid_request")
		return
	}
	uploadLock := &api.artifactUploads[sha256.Sum256([]byte(artifactID))[0]&63]
	uploadLock.Lock()
	defer uploadLock.Unlock()
	// Re-check after waiting on the single-active upload gate so a retried PUT
	// can observe the first request's durable available transition.
	artifact, upload, err = api.store.PrepareArtifactUpload(nodeID, generation, taskID, leaseToken, artifactID)
	if err != nil {
		writeStoreError(writer, err)
		return
	}
	if !upload {
		writeJSON(writer, http.StatusOK, publicAgentArtifact(artifact))
		return
	}
	objectKey := artifactObjectKey(artifact)
	request.Body = http.MaxBytesReader(writer, request.Body, int64(artifact.Size))
	if err := api.artifactStore.Put(request.Context(), objectKey, artifact.ContentType, artifact.Size, artifact.SHA256, request.Body); err != nil {
		_, _ = api.store.FailArtifactUpload(nodeID, generation, taskID, leaseToken, artifactID, "object_upload_failed")
		writeAPIError(writer, http.StatusServiceUnavailable, "unavailable")
		return
	}
	completed, err := api.store.CompleteArtifactUpload(nodeID, generation, taskID, leaseToken, artifactID, objectKey)
	if err != nil {
		_ = api.artifactStore.Delete(request.Context(), objectKey)
		writeStoreError(writer, err)
		return
	}
	writeJSON(writer, http.StatusCreated, publicAgentArtifact(completed))
}

type submitAPIRequest struct {
	ID            string          `json:"id"`
	ComputerID    string          `json:"computer_id"`
	Payload       json.RawMessage `json:"payload"`
	CredentialIDs []string        `json:"credential_ids,omitempty"`
}

func (api *API) tasks(writer http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodPost {
		writeAPIError(writer, http.StatusMethodNotAllowed, "method_not_allowed")
		return
	}
	identity, err := api.clientIdentity(request)
	if err != nil {
		writeAPIError(writer, http.StatusForbidden, "client_identity_required")
		return
	}
	var body submitAPIRequest
	if err := decodeAPIRequest(writer, request, &body); err != nil {
		writeAPIError(writer, http.StatusBadRequest, "invalid_request")
		return
	}
	task, created, err := api.store.Submit(identity.URI, SubmitRequest{
		ID: body.ID, Scope: Scope{TenantID: identity.TenantID, ProjectID: identity.ProjectID},
		ComputerID: body.ComputerID, Payload: body.Payload, CredentialIDs: body.CredentialIDs,
	})
	if err != nil {
		writeStoreError(writer, err)
		return
	}
	status := http.StatusOK
	if created {
		status = http.StatusCreated
	}
	writeJSON(writer, status, redactTask(task))
}

func (api *API) task(writer http.ResponseWriter, request *http.Request) {
	identity, err := api.clientIdentity(request)
	if err != nil {
		writeAPIError(writer, http.StatusForbidden, "client_identity_required")
		return
	}
	remainder := strings.TrimPrefix(request.URL.Path, "/v1/tasks/")
	parts := strings.Split(remainder, "/")
	if len(parts) < 1 || len(parts) > 2 || parts[0] == "" {
		writeAPIError(writer, http.StatusNotFound, "not_found")
		return
	}
	taskID := parts[0]
	scope := Scope{TenantID: identity.TenantID, ProjectID: identity.ProjectID}
	if len(parts) == 2 {
		if parts[1] != "events" || request.Method != http.MethodGet {
			writeAPIError(writer, http.StatusNotFound, "not_found")
			return
		}
		after, limit, ok := parsePage(request)
		if !ok {
			writeAPIError(writer, http.StatusBadRequest, "invalid_request")
			return
		}
		events, err := api.store.TaskEvents(scope, taskID, after, limit)
		if err != nil {
			writeStoreError(writer, err)
			return
		}
		writeJSON(writer, http.StatusOK, map[string]any{"events": events})
		return
	}
	var task Task
	switch request.Method {
	case http.MethodGet:
		task, err = api.store.InspectTask(scope, taskID)
	case http.MethodDelete:
		task, err = api.store.Cancel(identity.URI, scope, taskID)
	default:
		writeAPIError(writer, http.StatusMethodNotAllowed, "method_not_allowed")
		return
	}
	if err != nil {
		writeStoreError(writer, err)
		return
	}
	writeJSON(writer, http.StatusOK, redactTask(task))
}

func (api *API) audit(writer http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodGet {
		writeAPIError(writer, http.StatusMethodNotAllowed, "method_not_allowed")
		return
	}
	identity, err := api.clientIdentity(request)
	if err != nil {
		writeAPIError(writer, http.StatusForbidden, "client_identity_required")
		return
	}
	after, limit, ok := parsePage(request)
	if !ok {
		writeAPIError(writer, http.StatusBadRequest, "invalid_request")
		return
	}
	records, err := api.store.Audit(Scope{TenantID: identity.TenantID, ProjectID: identity.ProjectID}, after, limit)
	if err != nil {
		writeStoreError(writer, err)
		return
	}
	writeJSON(writer, http.StatusOK, map[string]any{"records": records})
}

func (api *API) adminNodes(writer http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodGet {
		writeAPIError(writer, http.StatusMethodNotAllowed, "method_not_allowed")
		return
	}
	if !api.isAdministrator(request) {
		writeAPIError(writer, http.StatusForbidden, "administrator_required")
		return
	}
	writeJSON(writer, http.StatusOK, map[string]any{"nodes": api.store.ListNodes()})
}

type drainRequest struct {
	Generation string `json:"generation"`
	Draining   bool   `json:"draining"`
}

func (api *API) adminNode(writer http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodPost {
		writeAPIError(writer, http.StatusNotFound, "not_found")
		return
	}
	if !api.isAdministrator(request) {
		writeAPIError(writer, http.StatusForbidden, "administrator_required")
		return
	}
	parts := strings.Split(strings.TrimPrefix(request.URL.Path, "/v1/admin/nodes/"), "/")
	if len(parts) == 4 && parts[0] != "" && parts[1] == "certificates" && parts[2] != "" && parts[3] == "revoke" {
		backend, ok := api.store.(NodeIdentityBackend)
		if api.nodeAuthority == nil || !ok {
			writeAPIError(writer, http.StatusNotFound, "not_found")
			return
		}
		principal, _ := api.principal(request)
		if err := backend.RevokeNodeCertificate(principal, parts[0], parts[2]); err != nil {
			writeStoreError(writer, err)
			return
		}
		writeJSON(writer, http.StatusOK, map[string]any{"node_id": parts[0], "serial_hex": parts[2], "state": "revoked"})
		return
	}
	if len(parts) != 2 || parts[0] == "" || parts[1] != "drain" {
		writeAPIError(writer, http.StatusNotFound, "not_found")
		return
	}
	var body drainRequest
	if err := decodeAPIRequest(writer, request, &body); err != nil {
		writeAPIError(writer, http.StatusBadRequest, "invalid_request")
		return
	}
	node, err := api.store.SetNodeDraining(parts[0], body.Generation, body.Draining)
	if err != nil {
		writeStoreError(writer, err)
		return
	}
	writeJSON(writer, http.StatusOK, node)
}

func (api *API) principal(request *http.Request) (string, error) {
	if request.TLS == nil || len(request.TLS.VerifiedChains) == 0 || len(request.TLS.PeerCertificates) == 0 {
		return "", errors.New("verified client certificate is required")
	}
	leaf := request.TLS.PeerCertificates[0]
	if len(leaf.URIs) != 1 {
		return "", errors.New("client certificate must contain exactly one URI SAN")
	}
	return leaf.URIs[0].String(), nil
}

func (api *API) nodeIdentity(request *http.Request) (string, error) {
	principal, err := api.principal(request)
	if err != nil {
		return "", err
	}
	trustDomain, nodeID, err := remoteauth.ParseNodeIdentity(principal)
	if err != nil || trustDomain != api.trustDomain {
		return "", errors.New("node SPIFFE identity is invalid")
	}
	if api.nodeAuthority != nil {
		backend, ok := api.store.(NodeIdentityBackend)
		if !ok {
			return "", errors.New("Node identity ledger is unavailable")
		}
		serialHex, err := requestCertificateSerial(request)
		if err != nil || backend.AuthorizeNodeCertificate(nodeID, serialHex) != nil {
			return "", errors.New("Node certificate is not authorized")
		}
	}
	return nodeID, nil
}

func requestCertificateSerial(request *http.Request) (string, error) {
	if request.TLS == nil || len(request.TLS.PeerCertificates) == 0 || request.TLS.PeerCertificates[0].SerialNumber == nil ||
		request.TLS.PeerCertificates[0].SerialNumber.Sign() <= 0 || request.TLS.PeerCertificates[0].SerialNumber.BitLen() > 128 {
		return "", errors.New("Node certificate serial is invalid")
	}
	return fmt.Sprintf("%032x", request.TLS.PeerCertificates[0].SerialNumber), nil
}

func (api *API) clientIdentity(request *http.Request) (remoteauth.Identity, error) {
	principal, err := api.principal(request)
	if err != nil {
		return remoteauth.Identity{}, err
	}
	return remoteauth.ParseClientIdentity(principal, api.trustDomain)
}

func (api *API) isAdministrator(request *http.Request) bool {
	identity, err := api.clientIdentity(request)
	if err != nil {
		return false
	}
	_, ok := api.administrators[identity.URI]
	return ok
}

func decodeAPIRequest(writer http.ResponseWriter, request *http.Request, destination any) error {
	request.Body = http.MaxBytesReader(writer, request.Body, maxAPIRequestSize)
	decoder := json.NewDecoder(request.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(destination); err != nil {
		return err
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		return errors.New("request contains trailing JSON")
	}
	return nil
}

func redactTask(task Task) Task {
	task.LeaseTokenHash = ""
	task.NodeGeneration = ""
	return task
}

func writeStoreError(writer http.ResponseWriter, err error) {
	status, code := classifyStoreError(err)
	writeAPIError(writer, status, code)
}

func classifyStoreError(err error) (int, string) {
	status, code := http.StatusBadRequest, "invalid_request"
	switch {
	case errors.Is(err, ErrNotFound):
		status, code = http.StatusNotFound, "not_found"
	case errors.Is(err, ErrUnauthorized):
		status, code = http.StatusForbidden, "forbidden"
	case errors.Is(err, ErrConflict), errors.Is(err, ErrTerminal):
		status, code = http.StatusConflict, "conflict"
	case errors.Is(err, ErrFenced):
		status, code = http.StatusConflict, "lease_fenced"
	case errors.Is(err, ErrComputerOffline):
		status, code = http.StatusServiceUnavailable, "computer_offline"
	case errors.Is(err, ErrUnavailable), errors.Is(err, ErrCapacityReached):
		status, code = http.StatusServiceUnavailable, "unavailable"
	case errors.Is(err, ErrStoreDegraded):
		status, code = http.StatusServiceUnavailable, "store_degraded"
	case errors.Is(err, ErrQuotaReached):
		status, code = http.StatusTooManyRequests, "quota_exceeded"
	}
	return status, code
}

func writeAPIError(writer http.ResponseWriter, status int, code string) {
	writeJSON(writer, status, APIErrorEnvelope{Error: classifyAPIError(code)})
}

func writeJSON(writer http.ResponseWriter, status int, value any) {
	writer.Header().Set("Content-Type", "application/json")
	writer.Header().Set(APIVersionHeader, APIVersion)
	writer.WriteHeader(status)
	_ = json.NewEncoder(writer).Encode(value)
}

func securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		writer.Header().Set("Cache-Control", "no-store")
		writer.Header().Set("Content-Security-Policy", "default-src 'none'")
		writer.Header().Set("X-Content-Type-Options", "nosniff")
		next.ServeHTTP(writer, request)
	})
}

func (api *API) limitRequests(next http.Handler) http.Handler {
	return http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		select {
		case api.requests <- struct{}{}:
			defer func() { <-api.requests }()
			next.ServeHTTP(writer, request)
		default:
			writeAPIError(writer, http.StatusServiceUnavailable, "overloaded")
		}
	})
}

func parsePage(request *http.Request) (uint64, int, bool) {
	var after uint64
	if raw := request.URL.Query().Get("after"); raw != "" {
		parsed, err := strconv.ParseUint(raw, 10, 64)
		if err != nil {
			return 0, 0, false
		}
		after = parsed
	}
	limit := 100
	if raw := request.URL.Query().Get("limit"); raw != "" {
		parsed, err := strconv.Atoi(raw)
		if err != nil {
			return 0, 0, false
		}
		limit = parsed
	}
	return after, limit, true
}
