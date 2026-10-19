package gitprovider

import (
	"context"
	"errors"
	"sort"
	"time"

	"zapvm/internal/credential"
)

// Descriptor is the non-secret repository identity exposed to an authorized
// tenant/project client.
type Descriptor struct {
	ID                string `json:"id"`
	Owner             string `json:"owner"`
	Repository        string `json:"repository"`
	DefaultBaseBranch string `json:"default_base_branch"`
}

// Capability is a short-lived Host-only credential. Token must never be
// serialized, persisted, logged, or sent into a Guest.
type Capability struct {
	ProviderID    string    `json:"-"`
	Owner         string    `json:"-"`
	Repository    string    `json:"-"`
	BaseBranch    string    `json:"-"`
	HTTPSCloneURL string    `json:"-"`
	Token         []byte    `json:"-"`
	ExpiresAt     time.Time `json:"-"`
}

func (capability *Capability) Destroy() {
	credential.ZeroBytes(capability.Token)
	capability.Token = nil
}

type Issuer interface {
	List(tenantID, projectID string) []Descriptor
	Mint(ctx context.Context, tenantID, projectID, providerID string) (Capability, error)
	ReconcilePullRequest(ctx context.Context, tenantID, projectID, providerID, operationID, branch, commitSHA string) (PullRequest, error)
}

type PullRequest struct {
	Number uint64 `json:"number"`
	URL    string `json:"url"`
	State  string `json:"state"`
}

type ProviderError struct {
	Code      string
	Retryable bool
}

func (providerError *ProviderError) Error() string { return providerError.Code }

func Retryable(err error) bool {
	var providerError *ProviderError
	return errors.As(err, &providerError) && providerError.Retryable
}

func SortDescriptors(providers []Descriptor) {
	sort.Slice(providers, func(left, right int) bool { return providers[left].ID < providers[right].ID })
}
