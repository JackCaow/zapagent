package cloudplane

import (
	"context"
	"time"
)

type StateMirrorHealth struct {
	Pending             bool
	Failed              bool
	ConsecutiveFailures uint64
	PendingSince        time.Time
	LastSuccess         time.Time
}

// StateMirror is a shadow durability sink. state.json remains authoritative:
// Reconcile must complete before serving, Enqueue receives only snapshots that
// are already durable on disk, and Close must flush the latest snapshot.
type StateMirror interface {
	Reconcile(context.Context, OfflineSnapshot) error
	Enqueue(OfflineSnapshot) error
	Health() StateMirrorHealth
	Close(context.Context) error
}

// StatePrimary is the synchronous single-active authority used during
// GA-01c. Load happens while the local Store lock is held. Commit must make
// the complete snapshot durable before returning; state.json is written only
// afterwards as a rollback cache.
type StatePrimary interface {
	Load(context.Context) (OfflineSnapshot, bool, error)
	Commit(context.Context, OfflineSnapshot) error
}
