package remoteauth

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

const (
	PolicySchemaVersion = 1
	maxPolicySize       = 1 << 20
)

var knownPermissions = map[string]struct{}{
	"computer.list":         {},
	"computer.inspect":      {},
	"computer.exec":         {},
	"computer.stop":         {},
	"computer.task.submit":  {},
	"computer.task.list":    {},
	"computer.task.inspect": {},
	"computer.task.attach":  {},
	"computer.task.cancel":  {},
	"computer.task.retry":   {},
}

type PolicyFile struct {
	SchemaVersion int     `json:"schema_version"`
	TrustDomain   string  `json:"trust_domain"`
	NodeID        string  `json:"node_id"`
	Grants        []Grant `json:"grants"`
}

type Grant struct {
	Principal     string   `json:"principal"`
	Permissions   []string `json:"permissions"`
	ComputerIDs   []string `json:"computer_ids"`
	CredentialIDs []string `json:"credential_ids,omitempty"`
}

type Identity struct {
	URI       string
	TenantID  string
	ProjectID string
	ClientID  string
}

type Policy struct {
	trustDomain string
	nodeID      string
	grants      map[string]compiledGrant
}

type compiledGrant struct {
	identity      Identity
	permissions   map[string]struct{}
	computerIDs   map[string]struct{}
	credentialIDs map[string]struct{}
}

func LoadPolicy(path string) (*Policy, error) {
	data, err := readSecureRegularFile(path, maxPolicySize, true)
	if err != nil {
		return nil, fmt.Errorf("load remote policy: %w", err)
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	var file PolicyFile
	if err := decoder.Decode(&file); err != nil {
		return nil, fmt.Errorf("decode remote policy: %w", err)
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		return nil, errors.New("remote policy contains trailing JSON")
	}
	return CompilePolicy(file)
}

func CompilePolicy(file PolicyFile) (*Policy, error) {
	if file.SchemaVersion != PolicySchemaVersion {
		return nil, fmt.Errorf("unsupported remote policy schema %d", file.SchemaVersion)
	}
	if !validName(file.TrustDomain, 253) || strings.Contains(file.TrustDomain, "/") {
		return nil, errors.New("remote policy trust_domain must be a lowercase DNS-style name")
	}
	if !validToken(file.NodeID, 128) {
		return nil, errors.New("remote policy node_id is invalid")
	}
	if len(file.Grants) == 0 || len(file.Grants) > 1024 {
		return nil, errors.New("remote policy requires 1-1024 grants")
	}
	policy := &Policy{trustDomain: file.TrustDomain, nodeID: file.NodeID, grants: make(map[string]compiledGrant, len(file.Grants))}
	for index, grant := range file.Grants {
		identity, err := ParseClientIdentity(grant.Principal, file.TrustDomain)
		if err != nil {
			return nil, fmt.Errorf("remote policy grant %d: %w", index, err)
		}
		if _, exists := policy.grants[identity.URI]; exists {
			return nil, fmt.Errorf("remote policy contains duplicate principal %q", identity.URI)
		}
		compiled := compiledGrant{
			identity: identity, permissions: make(map[string]struct{}),
			computerIDs: make(map[string]struct{}), credentialIDs: make(map[string]struct{}),
		}
		if len(grant.Permissions) == 0 || len(grant.Permissions) > len(knownPermissions) {
			return nil, fmt.Errorf("remote policy grant %d has an invalid permission count", index)
		}
		for _, permission := range grant.Permissions {
			if _, known := knownPermissions[permission]; !known {
				return nil, fmt.Errorf("remote policy grant %d has unknown permission %q", index, permission)
			}
			if _, duplicate := compiled.permissions[permission]; duplicate {
				return nil, fmt.Errorf("remote policy grant %d repeats permission %q", index, permission)
			}
			compiled.permissions[permission] = struct{}{}
		}
		if len(grant.ComputerIDs) == 0 || len(grant.ComputerIDs) > 1024 {
			return nil, fmt.Errorf("remote policy grant %d requires 1-1024 Computer IDs", index)
		}
		for _, id := range grant.ComputerIDs {
			if !validToken(id, 128) {
				return nil, fmt.Errorf("remote policy grant %d has invalid Computer ID", index)
			}
			if _, duplicate := compiled.computerIDs[id]; duplicate {
				return nil, fmt.Errorf("remote policy grant %d repeats Computer ID %q", index, id)
			}
			compiled.computerIDs[id] = struct{}{}
		}
		if len(grant.CredentialIDs) > 64 {
			return nil, fmt.Errorf("remote policy grant %d exceeds 64 credential IDs", index)
		}
		for _, id := range grant.CredentialIDs {
			if !validToken(id, 128) {
				return nil, fmt.Errorf("remote policy grant %d has invalid credential ID", index)
			}
			if _, duplicate := compiled.credentialIDs[id]; duplicate {
				return nil, fmt.Errorf("remote policy grant %d repeats credential ID %q", index, id)
			}
			compiled.credentialIDs[id] = struct{}{}
		}
		policy.grants[identity.URI] = compiled
	}
	return policy, nil
}

func ParseClientIdentity(raw, trustDomain string) (Identity, error) {
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Scheme != "spiffe" || parsed.Host != trustDomain || parsed.RawQuery != "" || parsed.Fragment != "" || parsed.User != nil {
		return Identity{}, errors.New("client principal must be a SPIFFE URI in the configured trust domain")
	}
	parts := strings.Split(strings.TrimPrefix(parsed.EscapedPath(), "/"), "/")
	if len(parts) != 6 || parts[0] != "tenant" || parts[2] != "project" || parts[4] != "client" {
		return Identity{}, errors.New("client principal path must be /tenant/<tenant>/project/<project>/client/<client>")
	}
	values := []string{parts[1], parts[3], parts[5]}
	for _, value := range values {
		decoded, decodeErr := url.PathUnescape(value)
		if decodeErr != nil || decoded != value || !validToken(value, 128) {
			return Identity{}, errors.New("client principal contains an invalid identity token")
		}
	}
	canonical := "spiffe://" + trustDomain + "/tenant/" + values[0] + "/project/" + values[1] + "/client/" + values[2]
	if raw != canonical {
		return Identity{}, errors.New("client principal is not canonical")
	}
	return Identity{URI: canonical, TenantID: values[0], ProjectID: values[1], ClientID: values[2]}, nil
}

func ParseNodeIdentity(raw string) (trustDomain, nodeID string, returnErr error) {
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Scheme != "spiffe" || !validName(parsed.Host, 253) || parsed.RawQuery != "" || parsed.Fragment != "" || parsed.User != nil {
		return "", "", errors.New("node identity must be a canonical SPIFFE URI")
	}
	parts := strings.Split(strings.TrimPrefix(parsed.EscapedPath(), "/"), "/")
	if len(parts) != 2 || parts[0] != "node" || !validToken(parts[1], 128) {
		return "", "", errors.New("node identity path must be /node/<node>")
	}
	canonical := "spiffe://" + parsed.Host + "/node/" + parts[1]
	if raw != canonical {
		return "", "", errors.New("node identity is not canonical")
	}
	return parsed.Host, parts[1], nil
}

func (policy *Policy) NodeURI() string {
	return "spiffe://" + policy.trustDomain + "/node/" + policy.nodeID
}

func (policy *Policy) NodeID() string {
	return policy.nodeID
}

func (policy *Policy) Identity(principal string) (Identity, bool) {
	grant, ok := policy.grants[principal]
	return grant.identity, ok
}

func (policy *Policy) Authorize(principal, permission, computerID string, credentialIDs []string) error {
	grant, ok := policy.grants[principal]
	if !ok {
		return errors.New("remote access denied")
	}
	if _, ok := grant.permissions[permission]; !ok {
		return errors.New("remote access denied")
	}
	if _, ok := grant.computerIDs[computerID]; !ok {
		return errors.New("remote access denied")
	}
	for _, id := range credentialIDs {
		if _, ok := grant.credentialIDs[id]; !ok {
			return errors.New("remote access denied")
		}
	}
	return nil
}

func (policy *Policy) ComputerIDs(principal, permission string) ([]string, error) {
	grant, ok := policy.grants[principal]
	if !ok {
		return nil, errors.New("remote access denied")
	}
	if _, ok := grant.permissions[permission]; !ok {
		return nil, errors.New("remote access denied")
	}
	result := make([]string, 0, len(grant.computerIDs))
	for id := range grant.computerIDs {
		result = append(result, id)
	}
	sort.Strings(result)
	return result, nil
}

func readSecureRegularFile(path string, maximum int64, ownerOnly bool) ([]byte, error) {
	if !filepath.IsAbs(path) || len(path) > 32767 || strings.IndexByte(path, 0) >= 0 {
		return nil, errors.New("path must be absolute and non-NUL")
	}
	parentInfo, err := os.Lstat(filepath.Dir(path))
	if err != nil {
		return nil, err
	}
	if !parentInfo.IsDir() || parentInfo.Mode()&os.ModeSymlink != 0 {
		return nil, errors.New("parent must be a real directory")
	}
	if ownerOnly {
		if err := validateOwnerOnlyDirectory(filepath.Dir(path), parentInfo); err != nil {
			return nil, err
		}
	}
	pathInfo, err := os.Lstat(path)
	if err != nil {
		return nil, err
	}
	if !pathInfo.Mode().IsRegular() || pathInfo.Mode()&os.ModeSymlink != 0 {
		return nil, errors.New("path must name a regular non-symlink file")
	}
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	fileInfo, err := file.Stat()
	if err != nil {
		return nil, err
	}
	if !fileInfo.Mode().IsRegular() || !os.SameFile(pathInfo, fileInfo) {
		return nil, errors.New("path changed while opening")
	}
	if fileInfo.Size() < 1 || fileInfo.Size() > maximum {
		return nil, fmt.Errorf("file size must be between 1 byte and %d bytes", maximum)
	}
	if ownerOnly {
		if err := validateOwnerOnlyFile(path, fileInfo); err != nil {
			return nil, err
		}
	}
	data, err := io.ReadAll(io.LimitReader(file, maximum+1))
	if err != nil {
		return nil, err
	}
	if int64(len(data)) != fileInfo.Size() {
		return nil, errors.New("file changed while reading")
	}
	return data, nil
}

// ReadOwnerOnlyFile exposes the same symlink, size, parent, identity, and
// owner/DACL checks used for remote private keys and policies.
func ReadOwnerOnlyFile(path string, maximum int64) ([]byte, error) {
	return readSecureRegularFile(path, maximum, true)
}

func validToken(value string, maximum int) bool {
	if value == "" || len(value) > maximum {
		return false
	}
	for _, character := range value {
		if (character >= 'a' && character <= 'z') || (character >= 'A' && character <= 'Z') || (character >= '0' && character <= '9') || character == '.' || character == '_' || character == '-' {
			continue
		}
		return false
	}
	return true
}

func validName(value string, maximum int) bool {
	if value == "" || len(value) > maximum || strings.ToLower(value) != value {
		return false
	}
	for _, character := range value {
		if (character >= 'a' && character <= 'z') || (character >= '0' && character <= '9') || character == '.' || character == '-' {
			continue
		}
		return false
	}
	for _, label := range strings.Split(value, ".") {
		if label == "" || len(label) > 63 || strings.HasPrefix(label, "-") || strings.HasSuffix(label, "-") {
			return false
		}
	}
	return true
}
