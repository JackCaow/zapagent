package cloudplane

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"sort"
)

const OfflineSnapshotFormatVersion = 1

// OfflineSnapshot is the validated, canonical input for the GA-01 file to
// PostgreSQL importer. StateJSON contains the same private authority as
// state.json and must never be logged or returned by an API.
type OfflineSnapshot struct {
	FormatVersion      int             `json:"format_version"`
	StateSchemaVersion int             `json:"state_schema_version"`
	StateJSON          json.RawMessage `json:"state"`
	Provisions         []NodeProvision `json:"provisions"`
}

func (snapshot OfflineSnapshot) CanonicalJSON() ([]byte, error) {
	if snapshot.FormatVersion != OfflineSnapshotFormatVersion || snapshot.StateSchemaVersion != stateSchemaVersion || len(snapshot.StateJSON) == 0 || !json.Valid(snapshot.StateJSON) {
		return nil, errors.New("cloud control-plane offline snapshot is invalid")
	}
	return json.Marshal(snapshot)
}

// OfflineSnapshot returns a deep, deterministic copy while the Store holds
// its exclusive state lock. Callers may retain or mutate the result.
func (store *Store) OfflineSnapshot() (OfflineSnapshot, error) {
	store.mu.Lock()
	defer store.mu.Unlock()
	if err := store.readyLocked(); err != nil {
		return OfflineSnapshot{}, err
	}
	return store.offlineSnapshotLocked()
}

func (store *Store) offlineSnapshotLocked() (OfflineSnapshot, error) {
	stateJSON, err := json.Marshal(store.state)
	if err != nil {
		return OfflineSnapshot{}, err
	}
	provisions := normalizedProvisions(store.provisions)
	return OfflineSnapshot{
		FormatVersion:      OfflineSnapshotFormatVersion,
		StateSchemaVersion: stateSchemaVersion,
		StateJSON:          append(json.RawMessage(nil), stateJSON...),
		Provisions:         provisions,
	}, nil
}

func normalizedProvisions(source map[string]NodeProvision) []NodeProvision {
	provisions := make([]NodeProvision, 0, len(source))
	for _, item := range source {
		provision := item
		provision.Scopes = append([]Scope(nil), item.Scopes...)
		provision.Computers = append([]ComputerProvision(nil), item.Computers...)
		sort.Slice(provision.Scopes, func(left, right int) bool {
			if provision.Scopes[left].TenantID != provision.Scopes[right].TenantID {
				return provision.Scopes[left].TenantID < provision.Scopes[right].TenantID
			}
			return provision.Scopes[left].ProjectID < provision.Scopes[right].ProjectID
		})
		sort.Slice(provision.Computers, func(left, right int) bool {
			if provision.Computers[left].TenantID != provision.Computers[right].TenantID {
				return provision.Computers[left].TenantID < provision.Computers[right].TenantID
			}
			if provision.Computers[left].ProjectID != provision.Computers[right].ProjectID {
				return provision.Computers[left].ProjectID < provision.Computers[right].ProjectID
			}
			if provision.Computers[left].ID != provision.Computers[right].ID {
				return provision.Computers[left].ID < provision.Computers[right].ID
			}
			return provision.Computers[left].Agent < provision.Computers[right].Agent
		})
		provisions = append(provisions, provision)
	}
	sort.Slice(provisions, func(left, right int) bool { return provisions[left].ID < provisions[right].ID })
	return provisions
}

func stateFromOfflineSnapshot(snapshot OfflineSnapshot, expected map[string]NodeProvision) (diskState, bool, error) {
	if _, err := snapshot.CanonicalJSON(); err != nil {
		return diskState{}, false, err
	}
	provided := make(map[string]NodeProvision, len(snapshot.Provisions))
	for _, provision := range snapshot.Provisions {
		if err := provision.Validate(); err != nil {
			return diskState{}, false, errors.New("cloud control-plane primary snapshot provision is invalid")
		}
		if _, duplicate := provided[provision.ID]; duplicate {
			return diskState{}, false, errors.New("cloud control-plane primary snapshot contains duplicate provisions")
		}
		provided[provision.ID] = provision
	}
	expectedJSON, err := json.Marshal(normalizedProvisions(expected))
	if err != nil {
		return diskState{}, false, err
	}
	providedJSON, err := json.Marshal(normalizedProvisions(provided))
	if err != nil {
		return diskState{}, false, err
	}
	provisionsChanged := !bytes.Equal(expectedJSON, providedJSON)
	if len(snapshot.StateJSON) > maxStateSize {
		return diskState{}, false, errors.New("cloud control-plane primary snapshot state exceeds its size limit")
	}
	var state diskState
	decoder := json.NewDecoder(bytes.NewReader(snapshot.StateJSON))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&state); err != nil {
		return diskState{}, false, errors.New("decode cloud control-plane primary snapshot state")
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		return diskState{}, false, errors.New("cloud control-plane primary snapshot state contains trailing JSON")
	}
	if state.SchemaVersion != snapshot.StateSchemaVersion {
		return diskState{}, false, errors.New("cloud control-plane primary snapshot state schema differs from its envelope")
	}
	return state, provisionsChanged, nil
}
