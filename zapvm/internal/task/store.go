package task

import (
	"bytes"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"zapvm/internal/computer"
)

const (
	SchemaVersion = 1
	MaxEventSize  = 1 << 20
	MaxEvents     = 100000
)

const (
	StateQueued      = "queued"
	StateRunning     = "running"
	StateCanceling   = "canceling"
	StateSucceeded   = "succeeded"
	StateFailed      = "failed"
	StateCanceled    = "canceled"
	StateInterrupted = "interrupted"
)

var (
	ErrExists      = errors.New("Task already exists")
	ErrConflict    = errors.New("Task ID was already used for a different request")
	ErrNotFound    = errors.New("Task does not exist")
	ErrTerminal    = errors.New("Task is already terminal")
	ErrCursorAhead = errors.New("Task cursor is ahead of the journal")
	ErrJournalFull = errors.New("Task journal reached its event limit")
)

type Event struct {
	SchemaVersion int    `json:"schema_version"`
	Cursor        uint64 `json:"cursor"`
	Timestamp     string `json:"timestamp"`
	TaskID        string `json:"task_id"`
	Type          string `json:"type"`

	ComputerID    string `json:"computer_id,omitempty"`
	RequestSHA256 string `json:"request_sha256,omitempty"`
	RetryOf       string `json:"retry_of,omitempty"`
	CommandID     string `json:"command_id,omitempty"`
	Stream        string `json:"stream,omitempty"`
	Data          []byte `json:"data,omitempty"`
	PID           int    `json:"pid,omitempty"`
	OK            *bool  `json:"ok,omitempty"`
	Error         string `json:"error,omitempty"`
}

type View struct {
	ID            string `json:"id"`
	ComputerID    string `json:"computer_id"`
	RequestSHA256 string `json:"request_sha256"`
	RetryOf       string `json:"retry_of,omitempty"`
	State         string `json:"state"`
	CreatedAt     string `json:"created_at"`
	UpdatedAt     string `json:"updated_at"`
	LastCursor    uint64 `json:"last_cursor"`
}

type Store struct {
	mu    sync.Mutex
	root  string
	now   func() time.Time
	views map[string]View
}

func Open(root string) (*Store, error) {
	if root == "" || !filepath.IsAbs(root) {
		return nil, errors.New("Task store root must be absolute")
	}
	if err := os.MkdirAll(root, 0o700); err != nil {
		return nil, err
	}
	if err := protectStoreRoot(root); err != nil {
		return nil, err
	}
	info, err := os.Lstat(root)
	if err != nil {
		return nil, err
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return nil, errors.New("Task store root must be a real directory")
	}
	if runtime.GOOS != "windows" && info.Mode().Perm() != 0o700 {
		return nil, errors.New("Task store root must have mode 0700")
	}
	return &Store{root: root, now: time.Now, views: make(map[string]View)}, nil
}

// Create is idempotent for the same caller-supplied ID and request digest.
func (store *Store) Create(id, computerID, requestSHA256 string) (View, bool, error) {
	return store.create(id, computerID, requestSHA256, "")
}

// CreateRetry records a new Task linked to a terminal source Task. The caller
// remains responsible for verifying that the retried request digest matches.
func (store *Store) CreateRetry(id, computerID, requestSHA256, retryOf string) (View, bool, error) {
	if !computer.ValidID(retryOf) || retryOf == id {
		return View{}, false, errors.New("retry source Task ID is invalid")
	}
	return store.create(id, computerID, requestSHA256, retryOf)
}

func (store *Store) create(id, computerID, requestSHA256, retryOf string) (View, bool, error) {
	store.mu.Lock()
	defer store.mu.Unlock()
	if !computer.ValidID(id) || !computer.ValidID(computerID) || !validDigest(requestSHA256) {
		return View{}, false, errors.New("Task ID, Computer ID, or request digest is invalid")
	}
	finalPath := store.taskPath(id)
	if _, err := os.Lstat(finalPath); err == nil {
		view, readErr := store.inspectLocked(id)
		if readErr != nil {
			return View{}, false, readErr
		}
		if view.ComputerID != computerID || view.RequestSHA256 != requestSHA256 || view.RetryOf != retryOf {
			return View{}, false, ErrConflict
		}
		return view, false, nil
	} else if !errors.Is(err, os.ErrNotExist) {
		return View{}, false, err
	}
	staging, err := os.MkdirTemp(store.root, ".task-*.tmp")
	if err != nil {
		return View{}, false, err
	}
	committed := false
	defer func() {
		if !committed {
			_ = os.RemoveAll(staging)
		}
	}()
	if err := os.Chmod(staging, 0o700); err != nil {
		return View{}, false, err
	}
	event := Event{
		SchemaVersion: SchemaVersion, Cursor: 1, Timestamp: store.timestamp(), TaskID: id,
		Type: "task.created", ComputerID: computerID, RequestSHA256: requestSHA256, RetryOf: retryOf,
	}
	if err := writeEvent(staging, event); err != nil {
		return View{}, false, err
	}
	if err := os.Rename(staging, finalPath); err != nil {
		if _, statErr := os.Lstat(finalPath); statErr == nil {
			return View{}, false, ErrExists
		}
		return View{}, false, err
	}
	if err := syncDirectory(store.root); err != nil {
		removeErr := os.RemoveAll(finalPath)
		return View{}, false, errors.Join(err, removeErr)
	}
	committed = true
	view := viewFromEvents([]Event{event})
	store.views[id] = view
	return view, true, nil
}

func (store *Store) Append(id string, event Event) (Event, View, error) {
	store.mu.Lock()
	defer store.mu.Unlock()
	view, err := store.viewLocked(id)
	if err != nil {
		return Event{}, View{}, err
	}
	if terminalState(view.State) {
		return Event{}, view, ErrTerminal
	}
	if view.LastCursor >= MaxEvents || (view.LastCursor >= MaxEvents-1 && !terminalEvent(event.Type)) {
		return Event{}, view, ErrJournalFull
	}
	event.SchemaVersion = SchemaVersion
	event.Cursor = view.LastCursor + 1
	event.Timestamp = store.timestamp()
	event.TaskID = id
	event.ComputerID = ""
	event.RequestSHA256 = ""
	event.RetryOf = ""
	if err := event.Validate(); err != nil {
		return Event{}, view, err
	}
	if err := validateTransition(view.State, event); err != nil {
		return Event{}, view, err
	}
	if err := writeEvent(store.taskPath(id), event); err != nil {
		// The atomic rename may have succeeded even if syncing the containing
		// directory failed. Drop the cached view so a retry rescans the journal
		// instead of reusing a possibly stale cursor.
		delete(store.views, id)
		return Event{}, view, err
	}
	view = advanceView(view, event)
	store.views[id] = view
	return cloneEvent(event), view, nil
}

// Prune removes at most limit terminal Tasks whose final event is older than
// before. Each Task directory is atomically moved out of the live namespace
// before deletion so readers never observe a partially deleted journal.
func (store *Store) Prune(before time.Time, limit int) ([]string, error) {
	store.mu.Lock()
	defer store.mu.Unlock()
	if before.IsZero() {
		return nil, errors.New("Task prune cutoff is required")
	}
	if limit < 1 || limit > 10000 {
		return nil, errors.New("Task prune limit must be between 1 and 10000")
	}
	entries, err := os.ReadDir(store.root)
	if err != nil {
		return nil, err
	}
	type candidate struct {
		id      string
		updated time.Time
	}
	var candidates []candidate
	cleanedTemporary := false
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), ".task-") && strings.HasSuffix(entry.Name(), ".tmp") {
			if err := os.RemoveAll(filepath.Join(store.root, entry.Name())); err != nil {
				return nil, err
			}
			cleanedTemporary = true
			continue
		}
		if !entry.IsDir() || !computer.ValidID(entry.Name()) {
			return nil, fmt.Errorf("Task store contains invalid entry %q", entry.Name())
		}
		view, err := store.inspectLocked(entry.Name())
		if err != nil {
			return nil, err
		}
		if !terminalState(view.State) {
			continue
		}
		updated, err := time.Parse(time.RFC3339Nano, view.UpdatedAt)
		if err != nil {
			return nil, fmt.Errorf("Task %q has invalid update timestamp: %w", view.ID, err)
		}
		if updated.Before(before) {
			candidates = append(candidates, candidate{id: view.ID, updated: updated})
		}
	}
	if cleanedTemporary {
		if err := syncDirectory(store.root); err != nil {
			return nil, err
		}
	}
	sort.Slice(candidates, func(left, right int) bool {
		if candidates[left].updated.Equal(candidates[right].updated) {
			return candidates[left].id < candidates[right].id
		}
		return candidates[left].updated.Before(candidates[right].updated)
	})
	if len(candidates) > limit {
		candidates = candidates[:limit]
	}
	removed := make([]string, 0, len(candidates))
	for _, current := range candidates {
		livePath := store.taskPath(current.id)
		tombstone, err := os.MkdirTemp(store.root, ".task-gc-*.tmp")
		if err != nil {
			return removed, err
		}
		if err := os.Remove(tombstone); err != nil {
			return removed, err
		}
		if err := os.Rename(livePath, tombstone); err != nil {
			return removed, err
		}
		if err := syncDirectory(store.root); err != nil {
			rollbackErr := os.Rename(tombstone, livePath)
			return removed, errors.Join(err, rollbackErr)
		}
		delete(store.views, current.id)
		if err := os.RemoveAll(tombstone); err != nil {
			return removed, err
		}
		if err := syncDirectory(store.root); err != nil {
			return removed, err
		}
		removed = append(removed, current.id)
	}
	return removed, nil
}

func (store *Store) Inspect(id string) (View, error) {
	store.mu.Lock()
	defer store.mu.Unlock()
	return store.inspectLocked(id)
}

func (store *Store) List(computerID string) ([]View, error) {
	store.mu.Lock()
	defer store.mu.Unlock()
	if computerID != "" && !computer.ValidID(computerID) {
		return nil, errors.New("invalid Computer ID")
	}
	entries, err := os.ReadDir(store.root)
	if err != nil {
		return nil, err
	}
	views := make([]View, 0, len(entries))
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), ".task-") && strings.HasSuffix(entry.Name(), ".tmp") {
			continue
		}
		if !entry.IsDir() || !computer.ValidID(entry.Name()) {
			return nil, fmt.Errorf("Task store contains invalid entry %q", entry.Name())
		}
		view, err := store.inspectLocked(entry.Name())
		if err != nil {
			return nil, err
		}
		if computerID == "" || view.ComputerID == computerID {
			views = append(views, view)
		}
	}
	sort.Slice(views, func(left, right int) bool {
		if views[left].CreatedAt == views[right].CreatedAt {
			return views[left].ID < views[right].ID
		}
		return views[left].CreatedAt < views[right].CreatedAt
	})
	return views, nil
}

func (store *Store) Read(id string, after uint64, limit int) ([]Event, View, error) {
	store.mu.Lock()
	defer store.mu.Unlock()
	if limit < 1 || limit > 1024 {
		return nil, View{}, errors.New("Task read limit must be between 1 and 1024")
	}
	view, err := store.viewLocked(id)
	if err != nil {
		return nil, View{}, err
	}
	if after > view.LastCursor {
		return nil, view, ErrCursorAhead
	}
	end := after + uint64(limit)
	if end > view.LastCursor {
		end = view.LastCursor
	}
	result := make([]Event, 0, end-after)
	for cursor := after + 1; cursor <= end; cursor++ {
		event, err := readEvent(filepath.Join(store.taskPath(id), eventName(cursor)))
		if err != nil {
			return nil, view, err
		}
		if event.TaskID != id || event.Cursor != cursor {
			return nil, view, errors.New("Task journal cursor or identity is inconsistent")
		}
		result = append(result, event)
	}
	return result, view, nil
}

// RecoverInterrupted appends one terminal event to tasks that could not have
// survived the previous daemon process. Completed journals remain immutable.
func (store *Store) RecoverInterrupted() ([]string, error) {
	views, err := store.List("")
	if err != nil {
		return nil, err
	}
	var recovered []string
	for _, view := range views {
		if terminalState(view.State) {
			continue
		}
		event := Event{Type: "task.interrupted", Error: "daemon_restarted"}
		if view.State == StateCanceling {
			event = Event{Type: "task.canceled", Error: "daemon_restarted_after_cancel"}
		}
		if _, _, err := store.Append(view.ID, event); err != nil {
			return recovered, err
		}
		recovered = append(recovered, view.ID)
	}
	return recovered, nil
}

func (event Event) Validate() error {
	if event.SchemaVersion != SchemaVersion || event.Cursor == 0 || !computer.ValidID(event.TaskID) || event.Timestamp == "" {
		return errors.New("Task event has invalid envelope fields")
	}
	switch event.Type {
	case "task.created":
		if event.Cursor != 1 || !computer.ValidID(event.ComputerID) || !validDigest(event.RequestSHA256) || (event.RetryOf != "" && (!computer.ValidID(event.RetryOf) || event.RetryOf == event.TaskID)) {
			return errors.New("Task creation event is invalid")
		}
	case "task.started", "task.cancel_requested", "task.canceled", "exec.scheduled", "exec.started", "exec.output", "exec.result", "task.interrupted":
		if event.ComputerID != "" || event.RequestSHA256 != "" || event.RetryOf != "" {
			return errors.New("non-creation Task event contains creation authority")
		}
	default:
		return errors.New("Task event type is invalid")
	}
	if len(event.Timestamp) > 64 || len(event.CommandID) > 256 || len(event.Stream) > 16 || len(event.Data) > 64<<10 || len(event.Error) > 64<<10 {
		return errors.New("Task event field exceeds its limit")
	}
	if event.Type == "exec.output" && event.Stream != "stdout" && event.Stream != "stderr" {
		return errors.New("Task output event has an invalid stream")
	}
	if event.Type == "exec.result" && event.OK == nil {
		return errors.New("Task result event has no outcome")
	}
	return nil
}

func (store *Store) inspectLocked(id string) (View, error) {
	return store.viewLocked(id)
}

func (store *Store) viewLocked(id string) (View, error) {
	if view, exists := store.views[id]; exists {
		return view, nil
	}
	events, err := store.readAllLocked(id)
	if err != nil {
		return View{}, err
	}
	view := viewFromEvents(events)
	store.views[id] = view
	return view, nil
}

func (store *Store) readAllLocked(id string) ([]Event, error) {
	if !computer.ValidID(id) {
		return nil, errors.New("invalid Task ID")
	}
	directory := store.taskPath(id)
	info, err := os.Lstat(directory)
	if errors.Is(err, os.ErrNotExist) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return nil, errors.New("Task path must be a real directory")
	}
	if runtime.GOOS != "windows" && info.Mode().Perm() != 0o700 {
		return nil, errors.New("Task directory must have mode 0700")
	}
	entries, err := os.ReadDir(directory)
	if err != nil {
		return nil, err
	}
	var names []string
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), ".event-") && strings.HasSuffix(entry.Name(), ".tmp") {
			continue
		}
		if entry.IsDir() || !validEventName(entry.Name()) {
			return nil, fmt.Errorf("Task journal contains invalid entry %q", entry.Name())
		}
		names = append(names, entry.Name())
	}
	sort.Strings(names)
	if len(names) == 0 || len(names) > MaxEvents {
		return nil, errors.New("Task journal is empty or exceeds its event limit")
	}
	events := make([]Event, 0, len(names))
	state := StateQueued
	for index, name := range names {
		event, err := readEvent(filepath.Join(directory, name))
		if err != nil {
			return nil, fmt.Errorf("read Task event %s: %w", name, err)
		}
		if event.TaskID != id || event.Cursor != uint64(index+1) || name != eventName(event.Cursor) {
			return nil, errors.New("Task journal cursor or identity is inconsistent")
		}
		if index == 0 && event.Type != "task.created" {
			return nil, errors.New("Task journal does not start with creation")
		}
		if index > 0 {
			if err := validateTransition(state, event); err != nil {
				return nil, err
			}
		}
		events = append(events, event)
		state = stateAfterEvent(state, event)
	}
	return events, nil
}

func writeEvent(directory string, event Event) error {
	if err := event.Validate(); err != nil {
		return err
	}
	data, err := json.Marshal(event)
	if err != nil {
		return err
	}
	data = append(data, '\n')
	if len(data) > MaxEventSize {
		return errors.New("Task event exceeds 1 MiB")
	}
	finalPath := filepath.Join(directory, eventName(event.Cursor))
	if _, err := os.Lstat(finalPath); err == nil {
		return errors.New("Task event cursor already exists")
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	temporary, err := os.CreateTemp(directory, ".event-*.tmp")
	if err != nil {
		return err
	}
	temporaryPath := temporary.Name()
	committed := false
	defer func() {
		_ = temporary.Close()
		if !committed {
			_ = os.Remove(temporaryPath)
		}
	}()
	if err := temporary.Chmod(0o600); err != nil {
		return err
	}
	if _, err := temporary.Write(data); err != nil {
		return err
	}
	if err := temporary.Sync(); err != nil {
		return err
	}
	if err := temporary.Close(); err != nil {
		return err
	}
	if err := os.Rename(temporaryPath, finalPath); err != nil {
		return err
	}
	if err := syncDirectory(directory); err != nil {
		return err
	}
	committed = true
	return nil
}

func readEvent(path string) (Event, error) {
	info, err := os.Lstat(path)
	if err != nil {
		return Event{}, err
	}
	if !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 || info.Size() <= 0 || info.Size() > MaxEventSize {
		return Event{}, errors.New("Task event must be a bounded regular file")
	}
	if runtime.GOOS != "windows" && info.Mode().Perm() != 0o600 {
		return Event{}, errors.New("Task event must have mode 0600")
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return Event{}, err
	}
	var event Event
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&event); err != nil {
		return Event{}, err
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		return Event{}, errors.New("Task event contains trailing JSON")
	}
	if err := event.Validate(); err != nil {
		return Event{}, err
	}
	return cloneEvent(event), nil
}

func validateTransition(state string, event Event) error {
	switch state {
	case StateQueued:
		if event.Type != "task.started" && event.Type != "task.cancel_requested" && event.Type != "task.interrupted" {
			return errors.New("queued Task received an invalid event")
		}
	case StateRunning:
		if event.Type != "task.cancel_requested" && event.Type != "exec.scheduled" && event.Type != "exec.started" && event.Type != "exec.output" && event.Type != "exec.result" && event.Type != "task.interrupted" {
			return errors.New("running Task received an invalid event")
		}
	case StateCanceling:
		if event.Type != "task.started" && event.Type != "task.canceled" && event.Type != "exec.scheduled" && event.Type != "exec.started" && event.Type != "exec.output" && event.Type != "exec.result" && event.Type != "task.interrupted" {
			return errors.New("canceling Task received an invalid event")
		}
	default:
		return ErrTerminal
	}
	return nil
}

func viewFromEvents(events []Event) View {
	first, last := events[0], events[len(events)-1]
	state := StateQueued
	for _, event := range events[1:] {
		switch event.Type {
		case "task.started", "exec.scheduled", "exec.started", "exec.output":
			if state != StateCanceling {
				state = StateRunning
			}
		case "task.cancel_requested":
			state = StateCanceling
		case "task.canceled":
			state = StateCanceled
		case "exec.result":
			if event.OK != nil && *event.OK {
				state = StateSucceeded
			} else {
				state = StateFailed
			}
		case "task.interrupted":
			state = StateInterrupted
		}
	}
	return View{
		ID: first.TaskID, ComputerID: first.ComputerID, RequestSHA256: first.RequestSHA256, RetryOf: first.RetryOf,
		State: state, CreatedAt: first.Timestamp, UpdatedAt: last.Timestamp, LastCursor: last.Cursor,
	}
}

func advanceView(view View, event Event) View {
	view.State = stateAfterEvent(view.State, event)
	view.UpdatedAt = event.Timestamp
	view.LastCursor = event.Cursor
	return view
}

func stateAfterEvent(current string, event Event) string {
	switch event.Type {
	case "task.started", "exec.scheduled", "exec.started", "exec.output":
		if current == StateCanceling {
			return StateCanceling
		}
		return StateRunning
	case "task.cancel_requested":
		return StateCanceling
	case "task.canceled":
		return StateCanceled
	case "exec.result":
		if event.OK != nil && *event.OK {
			return StateSucceeded
		}
		return StateFailed
	case "task.interrupted":
		return StateInterrupted
	default:
		return current
	}
}

func terminalState(state string) bool {
	return state == StateSucceeded || state == StateFailed || state == StateCanceled || state == StateInterrupted
}

func terminalEvent(eventType string) bool {
	return eventType == "exec.result" || eventType == "task.canceled" || eventType == "task.interrupted"
}

func IsTerminal(state string) bool { return terminalState(state) }

func validDigest(value string) bool {
	if len(value) != 64 {
		return false
	}
	decoded, err := hex.DecodeString(value)
	return err == nil && hex.EncodeToString(decoded) == value
}

func validEventName(name string) bool {
	if len(name) != 25 || !strings.HasSuffix(name, ".json") {
		return false
	}
	value, err := strconv.ParseUint(strings.TrimSuffix(name, ".json"), 10, 64)
	return err == nil && value > 0 && name == eventName(value)
}

func eventName(cursor uint64) string { return fmt.Sprintf("%020d.json", cursor) }

func (store *Store) taskPath(id string) string { return filepath.Join(store.root, id) }

func (store *Store) timestamp() string { return store.now().UTC().Format(time.RFC3339Nano) }

func cloneEvent(event Event) Event {
	event.Data = append([]byte(nil), event.Data...)
	if event.OK != nil {
		value := *event.OK
		event.OK = &value
	}
	return event
}
